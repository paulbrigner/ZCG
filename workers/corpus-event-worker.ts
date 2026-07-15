import { createHash, randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import type {
  GrantKnowledgeIndexResult,
  GrantKnowledgeRefreshOptions
} from "../lib/knowledge/documents";
import type { TargetedGitHubReconciliationResult } from "../lib/reconciliation/grants";
import { mirrorForumTopics } from "../lib/source-mirroring/forum";
import { storeNormalizedForumRecords } from "../lib/source-mirroring/forum-store";
import {
  GitHubPullRequestTargetError,
  mirrorGitHubIssue
} from "../lib/source-mirroring/github";
import {
  addCounts,
  recordSourceSnapshot,
  upsertSourceRecords,
  type SnapshotReference,
  type StoreCounts
} from "../lib/source-mirroring/store";
import type {
  SourceMirrorResult,
  TargetedSourceMirrorResult
} from "../lib/source-mirroring/types";
import { workerDatabaseUrl } from "../lib/worker-db-url";
import type { CorpusWebhookMessage } from "./webhook-ingress-worker";

const { Client } = pg;
const s3 = new S3Client({});

const CORPUS_REFRESH_LEASE_KEY = "corpus-refresh:pipeline:v1";
const CORPUS_REFRESH_LEASE_SCOPE = "corpus-refresh";
const DELIVERY_SCOPE = "corpus-webhook-delivery";
const DEFAULT_DELIVERY_LEASE_SECONDS = 15 * 60;
const DEFAULT_PIPELINE_LEASE_SECONDS = 30 * 60;
const DEFAULT_GITHUB_OWNER = "ZcashCommunityGrants";
const DEFAULT_GITHUB_REPO = "zcashcommunitygrants";

export type SqsRecord = {
  messageId: string;
  body: string;
};

export type SqsEvent = {
  Records?: SqsRecord[];
};

export type SqsBatchResponse = {
  batchItemFailures: Array<{ itemIdentifier: string }>;
};

type MessageEntry = {
  record: SqsRecord;
  message: CorpusWebhookMessage;
};

type MessageGroup = {
  key: string;
  provider: CorpusWebhookMessage["provider"];
  entries: MessageEntry[];
};

type DeliveryClaim = {
  key: string;
  owner: string;
  deliveryId: string;
  entries: MessageEntry[];
};

type QueryClient = Pick<pg.Client, "query" | "end">;

type StoredMirrorResult = {
  counts: StoreCounts;
  snapshotKey: string | null;
  normalizedForum: Awaited<ReturnType<typeof storeNormalizedForumRecords>>;
};

type TargetedReconciliation = (options: {
  githubSourceId: string;
  syncRunId?: string | null;
}) => Promise<TargetedGitHubReconciliationResult>;

type ScopedKnowledgeRefresh = (
  options?: GrantKnowledgeRefreshOptions
) => Promise<GrantKnowledgeIndexResult>;

export type CorpusEventWorkerDependencies = {
  connect?: () => Promise<QueryClient>;
  now?: () => Date;
  randomId?: () => string;
  mirrorGitHubIssue?: typeof mirrorGitHubIssue;
  mirrorForumTopics?: typeof mirrorForumTopics;
  runTargetedGitHubReconciliation?: TargetedReconciliation;
  refreshGrantKnowledgeDocuments?: ScopedKnowledgeRefresh;
  storeMirrorResult?: (
    client: QueryClient,
    syncRunId: string,
    result: SourceMirrorResult
  ) => Promise<StoredMirrorResult>;
  logError?: (...values: unknown[]) => void;
};

type ProcessResult = {
  counts: StoreCounts;
  metadata: Record<string, unknown>;
};

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseWebhookMessage(body: string): CorpusWebhookMessage {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("SQS message body is not valid JSON.");
  }

  const value = recordValue(parsed);
  const provider = nonEmptyString(value?.provider);
  const deliveryId = nonEmptyString(value?.deliveryId);
  const eventType = nonEmptyString(value?.eventType);
  const action = nonEmptyString(value?.action);
  const receivedAt = nonEmptyString(value?.receivedAt);
  const source = recordValue(value?.source);

  if (
    value?.schemaVersion !== 1 ||
    !["github", "discourse", "google-drive"].includes(provider ?? "") ||
    !deliveryId ||
    !eventType ||
    !action ||
    !receivedAt ||
    !source
  ) {
    throw new Error("SQS message body is not a supported corpus webhook envelope.");
  }

  if (provider === "github") {
    const repository = nonEmptyString(source.repository);
    const issueNumber = source.issueNumber === undefined
      ? undefined
      : positiveInteger(source.issueNumber) ?? undefined;
    const commentId = source.commentId === undefined
      ? undefined
      : positiveInteger(source.commentId) ?? undefined;
    const isPullRequest = source.isPullRequest === true;

    if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error("GitHub corpus webhook is missing a valid repository.");
    }

    return {
      schemaVersion: 1,
      provider,
      deliveryId,
      eventType,
      action,
      source: {
        repository,
        ...(issueNumber ? { issueNumber } : {}),
        ...(commentId ? { commentId } : {}),
        ...(isPullRequest ? { isPullRequest: true } : {})
      },
      receivedAt
    };
  }

  if (provider === "discourse") {
    const topicId = source.topicId === undefined
      ? undefined
      : positiveInteger(source.topicId) ?? undefined;
    const postId = source.postId === undefined
      ? undefined
      : positiveInteger(source.postId) ?? undefined;

    return {
      schemaVersion: 1,
      provider,
      deliveryId,
      eventType,
      action,
      source: {
        ...(topicId ? { topicId } : {}),
        ...(postId ? { postId } : {})
      },
      receivedAt
    };
  }

  const channelId = nonEmptyString(source.channelId);

  if (!channelId) {
    throw new Error("Google Drive corpus webhook is missing its channel ID.");
  }

  return {
    schemaVersion: 1,
    provider: "google-drive",
    deliveryId,
    eventType: "drive-notification",
    action,
    source: {
      channelId,
      ...(nonEmptyString(source.resourceId) ? { resourceId: nonEmptyString(source.resourceId)! } : {}),
      ...(nonEmptyString(source.resourceUri) ? { resourceUri: nonEmptyString(source.resourceUri)! } : {}),
      ...(nonEmptyString(source.fileId) ? { fileId: nonEmptyString(source.fileId)! } : {})
    },
    receivedAt
  };
}

function groupKey(message: CorpusWebhookMessage) {
  if (message.provider === "github") {
    return `github:${message.source.repository.toLowerCase()}#${message.source.issueNumber ?? "repository"}`;
  }

  if (message.provider === "discourse") {
    return `discourse:${message.source.topicId ?? `post:${message.source.postId ?? "unknown"}`}`;
  }

  return `google-drive:${message.source.fileId ?? message.source.resourceId ?? message.source.channelId}`;
}

function coalesceMessages(entries: MessageEntry[]) {
  const groups = new Map<string, MessageGroup>();

  for (const entry of entries) {
    const key = groupKey(entry.message);
    const existing = groups.get(key);

    if (existing) {
      existing.entries.push(entry);
    } else {
      groups.set(key, {
        key,
        provider: entry.message.provider,
        entries: [entry]
      });
    }
  }

  return [...groups.values()];
}

function deliveryIdempotencyKey(provider: CorpusWebhookMessage["provider"], deliveryId: string) {
  return `corpus-webhook:${provider}:${deliveryId}`;
}

function configuredDeliveryLeaseSeconds() {
  return positiveInteger(process.env.CORPUS_EVENT_DELIVERY_LEASE_SECONDS)
    ?? DEFAULT_DELIVERY_LEASE_SECONDS;
}

function configuredPipelineLeaseSeconds() {
  return positiveInteger(process.env.CORPUS_EVENT_PIPELINE_LEASE_SECONDS)
    ?? DEFAULT_PIPELINE_LEASE_SECONDS;
}

function configuredGitHubRepository() {
  const owner = process.env.ZCG_GITHUB_OWNER ?? DEFAULT_GITHUB_OWNER;
  const repo = process.env.ZCG_GITHUB_REPO ?? DEFAULT_GITHUB_REPO;
  return `${owner}/${repo}`;
}

async function defaultConnect() {
  const connectionString = await configuredWorkerDatabaseUrl();
  const client = new Client({
    connectionString,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined
  });
  await client.connect();
  return client;
}

async function configuredWorkerDatabaseUrl() {
  const connectionString = await workerDatabaseUrl();
  process.env.DATABASE_DRIVER = "pg";
  process.env.DATABASE_URL = connectionString;
  return connectionString;
}

async function defaultTargetedReconciliation(
  options: Parameters<TargetedReconciliation>[0]
) {
  await configuredWorkerDatabaseUrl();
  const { runTargetedGitHubReconciliation } = await import("../lib/reconciliation/grants");
  return runTargetedGitHubReconciliation(options);
}

async function defaultScopedKnowledgeRefresh(
  options: GrantKnowledgeRefreshOptions = {}
) {
  await configuredWorkerDatabaseUrl();
  const { refreshGrantKnowledgeDocuments } = await import("../lib/knowledge/documents");
  return refreshGrantKnowledgeDocuments(options);
}

async function acquireCorpusEventPipelineLease(
  client: QueryClient,
  params: { owner: string; sourceKey: string; acquiredAt: string }
) {
  const payload = {
    owner: params.owner,
    ownerKind: "corpus_event",
    sourceKey: params.sourceKey,
    acquiredAt: params.acquiredAt
  };
  await client.query("begin");

  try {
    const existing = await client.query<{
      result: Record<string, unknown> | null;
      reclaimable: boolean;
    }>(
      `select result,
              (locked_until is null or locked_until <= now()) as reclaimable
         from idempotency_keys
        where key = $1
        for update`,
      [CORPUS_REFRESH_LEASE_KEY]
    );
    const previousResult = existing.rows[0]?.result ?? {};
    const acquired = await client.query<{
      locked_until: string;
      result: Record<string, unknown>;
    }>(
      `insert into idempotency_keys (key, scope, locked_until, result, created_at, updated_at)
       values (
         $1,
         $2,
         now() + ($3::integer * interval '1 second'),
         $4::jsonb,
         now(),
         now()
       )
       on conflict (key)
       do update set scope = excluded.scope,
                     locked_until = excluded.locked_until,
                     result = excluded.result,
                     updated_at = now()
         where idempotency_keys.locked_until is null
            or idempotency_keys.locked_until <= now()
       returning locked_until::text, result`,
      [
        CORPUS_REFRESH_LEASE_KEY,
        CORPUS_REFRESH_LEASE_SCOPE,
        configuredPipelineLeaseSeconds(),
        JSON.stringify(payload)
      ]
    );

    if (!acquired.rowCount) {
      const busy = await client.query<{
        locked_until: string | null;
        owner_kind: string | null;
      }>(
        `select locked_until::text,
                result->>'ownerKind' as owner_kind
           from idempotency_keys
          where key = $1
          limit 1`,
        [CORPUS_REFRESH_LEASE_KEY]
      );
      await client.query("rollback");

      return {
        acquired: false as const,
        ownerKind: busy.rows[0]?.owner_kind ?? "full_refresh",
        lockedUntil: busy.rows[0]?.locked_until ?? null
      };
    }

    const previousParentSyncRunId = previousResult.parentSyncRunId;

    if (
      existing.rows[0]?.reclaimable === true &&
      (previousResult.ownerKind === "full_refresh" || previousResult.ownerKind === "sheet_refresh") &&
      typeof previousParentSyncRunId === "string" &&
      previousParentSyncRunId
    ) {
      const expiredRefreshName = previousResult.ownerKind === "sheet_refresh"
        ? "Google Sheet refresh"
        : "full corpus refresh";
      await client.query(
        `update sync_runs
            set status = 'failed',
                error_summary = coalesce(
                  error_summary,
                  $3::text
                ),
                metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                  'staleLeaseRecoveredBy', 'corpus_event',
                  'staleLeaseRecoveredByOwner', $2::text,
                  'staleLeaseRecoveredAt', now()
                ),
                completed_at = coalesce(completed_at, now())
          where id = $1
            and status = 'running'`,
        [
          previousParentSyncRunId,
          params.owner,
          `The ${expiredRefreshName} lease expired before the workflow finalized.`
        ]
      );
    }

    await client.query("commit");
    return {
      acquired: true as const,
      ownerKind: "corpus_event",
      lockedUntil: acquired.rows[0]?.locked_until ?? null
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function releaseCorpusEventPipelineLease(client: QueryClient, owner: string) {
  const released = await client.query(
    `delete from idempotency_keys
      where key = $1
        and scope = $2
        and result->>'ownerKind' = 'corpus_event'
        and result->>'owner' = $3`,
    [CORPUS_REFRESH_LEASE_KEY, CORPUS_REFRESH_LEASE_SCOPE, owner]
  );

  return (released.rowCount ?? 0) > 0;
}

async function claimDelivery(
  client: QueryClient,
  params: {
    provider: CorpusWebhookMessage["provider"];
    deliveryId: string;
    owner: string;
    now: string;
    sourceKey: string;
  }
) {
  const key = deliveryIdempotencyKey(params.provider, params.deliveryId);
  const payload = {
    status: "processing",
    owner: params.owner,
    provider: params.provider,
    deliveryId: params.deliveryId,
    sourceKey: params.sourceKey,
    claimedAt: params.now
  };
  const claimed = await client.query<{ result: Record<string, unknown> }>(
    `insert into idempotency_keys (key, scope, locked_until, result, created_at, updated_at)
     values (
       $1,
       $2,
       now() + ($3::integer * interval '1 second'),
       $4::jsonb,
       now(),
       now()
     )
     on conflict (key)
     do update set scope = excluded.scope,
                   locked_until = excluded.locked_until,
                   result = excluded.result,
                   updated_at = now()
       where idempotency_keys.scope = $2
         and idempotency_keys.result->>'status' is distinct from 'completed'
         and (
           idempotency_keys.locked_until is null
           or idempotency_keys.locked_until <= now()
           or idempotency_keys.result->>'status' = 'failed'
         )
     returning result`,
    [key, DELIVERY_SCOPE, configuredDeliveryLeaseSeconds(), JSON.stringify(payload)]
  );

  if (claimed.rowCount) {
    return { status: "acquired" as const, key };
  }

  const existing = await client.query<{ result: Record<string, unknown> | null }>(
    `select result
       from idempotency_keys
      where key = $1
        and scope = $2
      limit 1`,
    [key, DELIVERY_SCOPE]
  );

  return existing.rows[0]?.result?.status === "completed"
    ? { status: "completed" as const, key }
    : { status: "busy" as const, key };
}

async function finishDelivery(
  client: QueryClient,
  claim: DeliveryClaim,
  params: {
    status: "completed" | "failed";
    completedAt: string;
    syncRunId?: string | null;
    sourceKey: string;
    error?: string;
  }
) {
  await client.query(
    `update idempotency_keys
        set locked_until = null,
            result = $3::jsonb,
            updated_at = now()
      where key = $1
        and scope = $2
        and result->>'owner' = $4`,
    [
      claim.key,
      DELIVERY_SCOPE,
      JSON.stringify({
        status: params.status,
        provider: claim.entries[0]?.message.provider ?? null,
        deliveryId: claim.deliveryId,
        sourceKey: params.sourceKey,
        syncRunId: params.syncRunId ?? null,
        completedAt: params.completedAt,
        ...(params.error ? { error: params.error } : {})
      }),
      claim.owner
    ]
  );
}

function safeSnapshotSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._=-]+/g, "-").slice(0, 160);
}

async function putSnapshot(
  syncRunId: string,
  result: SourceMirrorResult
): Promise<SnapshotReference | null> {
  const bucket = process.env.SNAPSHOT_BUCKET_NAME;

  if (!bucket) {
    return null;
  }

  const body = JSON.stringify(result.rawPayload, null, 2);
  const checksum = createHash("sha256").update(body).digest("hex");
  const key = [
    "source-mirrors/events",
    safeSnapshotSegment(result.sourceKind),
    safeSnapshotSegment(result.sourceId),
    `${syncRunId}.json`
  ].join("/");

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: "application/json",
    ServerSideEncryption: "AES256",
    Metadata: { checksum }
  }));

  return { bucket, key, checksum };
}

async function defaultStoreMirrorResult(
  client: QueryClient,
  syncRunId: string,
  result: SourceMirrorResult
): Promise<StoredMirrorResult> {
  const snapshot = await putSnapshot(syncRunId, result);
  const rawSnapshotId = await recordSourceSnapshot(
    client as pg.Client,
    { syncRunId, result, snapshot }
  );
  const counts = await upsertSourceRecords(client as pg.Client, result.records, rawSnapshotId);
  const normalizedForum = await storeNormalizedForumRecords(client as pg.Client, {
    syncRunId,
    records: result.records
  });

  return {
    counts,
    snapshotKey: snapshot?.key ?? null,
    normalizedForum
  };
}

async function createSyncRun(client: QueryClient, group: MessageGroup) {
  const metadata = {
    phase: "corpus_event",
    provider: group.provider,
    sourceKey: group.key,
    deliveryIds: [...new Set(group.entries.map((entry) => entry.message.deliveryId))],
    receivedAt: group.entries.map((entry) => entry.message.receivedAt).sort()[0] ?? null,
    eventTypes: [...new Set(group.entries.map((entry) => entry.message.eventType))],
    actions: [...new Set(group.entries.map((entry) => entry.message.action))]
  };
  const result = await client.query<{ id: string }>(
    `insert into sync_runs (source, status, metadata, started_at)
     values ($1, 'running', $2::jsonb, now())
     returning id`,
    [`webhook-${group.provider}`, JSON.stringify(metadata)]
  );
  const syncRunId = result.rows[0]?.id;

  if (!syncRunId) {
    throw new Error("Failed to create the corpus event sync run.");
  }

  return syncRunId;
}

async function completeSyncRun(
  client: QueryClient,
  syncRunId: string,
  result: ProcessResult
) {
  await client.query(
    `update sync_runs
        set status = 'completed',
            records_seen = $2,
            records_created = $3,
            records_updated = $4,
            records_skipped = $5,
            metadata = coalesce(metadata, '{}'::jsonb) || $6::jsonb,
            completed_at = now()
      where id = $1`,
    [
      syncRunId,
      result.counts.recordsSeen,
      result.counts.recordsCreated,
      result.counts.recordsUpdated,
      result.counts.recordsSkipped,
      JSON.stringify(result.metadata)
    ]
  );
  await client.query(
    `insert into audit_events (action, target_type, target_id, metadata)
     values ($1, 'sync_run', $2, $3::jsonb)`,
    [
      result.metadata.requiresFullRefresh === true
        ? "corpus_event.processed_requires_full_refresh"
        : "corpus_event.processed",
      syncRunId,
      JSON.stringify(result.metadata)
    ]
  );
}

async function failSyncRun(
  client: QueryClient,
  syncRunId: string,
  group: MessageGroup,
  error: unknown
) {
  const message = error instanceof Error ? error.message : String(error);
  const metadata = {
    phase: "corpus_event",
    provider: group.provider,
    sourceKey: group.key,
    deliveryIds: [...new Set(group.entries.map((entry) => entry.message.deliveryId))]
  };

  await client.query(
    `update sync_runs
        set status = 'failed',
            error_summary = $2,
            metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb,
            completed_at = now()
      where id = $1`,
    [syncRunId, message, JSON.stringify(metadata)]
  );
  await client.query(
    `insert into audit_events (action, target_type, target_id, metadata)
     values ('corpus_event.failed', 'sync_run', $1, $2::jsonb)`,
    [syncRunId, JSON.stringify({ ...metadata, error: message })]
  );
}

async function linkedApplicationIdsForGitHub(client: QueryClient, githubSourceId: string) {
  const result = await client.query<{ application_id: string }>(
    `select distinct sl.canonical_id::text as application_id
       from source_links sl
       join source_records sr on sr.id = sl.source_record_id
      where sl.canonical_type = 'grant_application'
        and (
          (sr.source_kind = 'github_issue' and sr.source_id = $1)
          or (
            sr.source_kind = 'github_issue_comment'
            and left(sr.source_id, length($2)) = $2
          )
        )`,
    [githubSourceId, `${githubSourceId}:comment:`]
  );

  return result.rows.map((row) => row.application_id);
}

async function applyTargetedCleanup(
  client: QueryClient,
  result: TargetedSourceMirrorResult
) {
  let recordsDeleted = 0;

  for (const scope of result.authoritativeScopes) {
    const deleted = await client.query(
      `delete from source_records
        where source_kind = $1
          and left(source_id, length($2)) = $2
          and not (source_id = any($3::text[]))`,
      [scope.sourceKind, scope.sourceIdPrefix, scope.currentSourceIds]
    );
    recordsDeleted += deleted.rowCount ?? 0;
  }

  for (const tombstone of result.tombstones.filter((item) => item.sourceIdPrefix)) {
    const deleted = await client.query(
      `delete from source_records
        where source_kind = $1
          and left(source_id, length($2)) = $2`,
      [tombstone.sourceKind, tombstone.sourceIdPrefix]
    );
    recordsDeleted += deleted.rowCount ?? 0;
  }

  for (const tombstone of result.tombstones.filter((item) => item.sourceId)) {
    const deleted = await client.query(
      `delete from source_records
        where source_kind = $1
          and source_id = $2`,
      [tombstone.sourceKind, tombstone.sourceId]
    );
    recordsDeleted += deleted.rowCount ?? 0;
  }

  return recordsDeleted;
}

async function unmirroredForumUrls(client: QueryClient, urls: string[]) {
  if (!urls.length) {
    return [];
  }

  const result = await client.query<{ source_id: string }>(
    `select source_id
       from source_records
      where source_kind in ('forum_link', 'forum_update_topic', 'forum_meeting_minutes')
        and source_id = any($1::text[])
        and metadata->>'mirrorKind' in ('forum_topic', 'forum_update_topic', 'forum_meeting_minutes')`,
    [urls]
  );
  const mirrored = new Set(result.rows.map((row) => row.source_id));
  return urls.filter((url) => !mirrored.has(url));
}

async function knownForumTopicContext(client: QueryClient, topicId: number) {
  const result = await client.query<{ url: string | null; application_id: string | null }>(
    `select distinct coalesce(dtr.referenced_url, dt.canonical_url) as url,
            sl.canonical_id::text as application_id
       from discourse_topics dt
       left join discourse_topic_references dtr on dtr.discourse_topic_id = dt.id
       left join source_links sl
         on sl.source_record_id = dtr.source_record_id
        and sl.canonical_type = 'grant_application'
      where dt.forum_host = 'forum.zcashcommunity.com'
        and dt.topic_id = $1
      union
     select distinct coalesce(sr.source_url, sr.source_id) as url,
            sl.canonical_id::text as application_id
       from source_records sr
       left join source_links sl
         on sl.source_record_id = sr.id
        and sl.canonical_type = 'grant_application'
      where sr.source_kind in ('forum_link', 'forum_update_topic', 'forum_meeting_minutes')
        and sr.metadata->>'topicId' = $1::text`,
    [topicId]
  );

  return {
    urls: [...new Set(result.rows.map((row) => nonEmptyString(row.url)).filter(Boolean) as string[])],
    applicationIds: [
      ...new Set(
        result.rows
          .map((row) => nonEmptyString(row.application_id))
          .filter(Boolean) as string[]
      )
    ]
  };
}

function forumMirrorNeedsRetry(result: SourceMirrorResult) {
  return (
    result.rawPayload.rateLimitedAt !== null &&
    result.rawPayload.rateLimitedAt !== undefined
  ) || Number(result.rawPayload.topicErrorCount ?? 0) > 0;
}

function forumMirrorUnavailable(result: SourceMirrorResult) {
  return Number(result.rawPayload.topicCountUnavailable ?? 0) > 0;
}

async function scopedKnowledgeRefresh(
  applicationIds: string[],
  refresh: ScopedKnowledgeRefresh
) {
  const uniqueIds = [...new Set(applicationIds)].sort();

  if (!uniqueIds.length) {
    return {
      applicationIds: [],
      result: { skipped: true, reason: "no_affected_applications" }
    };
  }

  return {
    applicationIds: uniqueIds,
    result: await refresh({ applicationIds: uniqueIds })
  };
}

async function processGitHubGroup(
  client: QueryClient,
  syncRunId: string,
  group: MessageGroup,
  dependencies: Required<Pick<
    CorpusEventWorkerDependencies,
    | "mirrorGitHubIssue"
    | "mirrorForumTopics"
    | "runTargetedGitHubReconciliation"
    | "refreshGrantKnowledgeDocuments"
    | "storeMirrorResult"
  >>
): Promise<ProcessResult> {
  const message = group.entries.at(-1)!.message;

  if (message.provider !== "github") {
    throw new Error("GitHub event group contained a different provider.");
  }

  if (!message.source.issueNumber) {
    return {
      counts: { recordsSeen: group.entries.length, recordsCreated: 0, recordsUpdated: 0, recordsSkipped: group.entries.length },
      metadata: {
        provider: "github",
        sourceKey: group.key,
        ignored: true,
        reason: "repository_event_has_no_issue",
        requiresFullRefresh: false
      }
    };
  }

  if (message.source.repository.toLowerCase() !== configuredGitHubRepository().toLowerCase()) {
    return {
      counts: {
        recordsSeen: group.entries.length,
        recordsCreated: 0,
        recordsUpdated: 0,
        recordsSkipped: group.entries.length
      },
      metadata: {
        provider: "github",
        sourceKey: group.key,
        ignored: true,
        reason: "repository_mismatch",
        receivedRepository: message.source.repository,
        configuredRepository: configuredGitHubRepository(),
        requiresFullRefresh: false
      }
    };
  }

  if (message.source.isPullRequest === true) {
    return {
      counts: {
        recordsSeen: group.entries.length,
        recordsCreated: 0,
        recordsUpdated: 0,
        recordsSkipped: group.entries.length
      },
      metadata: {
        provider: "github",
        sourceKey: group.key,
        ignored: true,
        reason: "pull_request_event",
        issueNumber: message.source.issueNumber,
        requiresFullRefresh: false
      }
    };
  }

  const canonicalRepository = configuredGitHubRepository();
  const [owner, repo] = canonicalRepository.split("/") as [string, string];
  const githubSourceId = `${canonicalRepository}#${message.source.issueNumber}`;
  const previouslyLinkedApplicationIds = await linkedApplicationIdsForGitHub(client, githubSourceId);
  let mirror: TargetedSourceMirrorResult;

  try {
    mirror = await dependencies.mirrorGitHubIssue(message.source.issueNumber, { owner, repo });
  } catch (error) {
    if (error instanceof GitHubPullRequestTargetError) {
      return {
        counts: {
          recordsSeen: group.entries.length,
          recordsCreated: 0,
          recordsUpdated: 0,
          recordsSkipped: group.entries.length
        },
        metadata: {
          provider: "github",
          sourceKey: group.key,
          ignored: true,
          reason: "pull_request_event",
          issueNumber: error.issueNumber,
          requiresFullRefresh: false
        }
      };
    }

    throw error;
  }
  const stored = await dependencies.storeMirrorResult(client, syncRunId, mirror);
  const recordsDeleted = await applyTargetedCleanup(client, mirror);
  const reconciliation = await dependencies.runTargetedGitHubReconciliation({
    githubSourceId,
    syncRunId
  });
  const newlyDiscoveredForumUrls = await unmirroredForumUrls(
    client,
    reconciliation.discoveredForumUrls
  );
  let counts = stored.counts;
  let forum: Record<string, unknown> | null = null;
  let forumUnavailable = false;

  if (newlyDiscoveredForumUrls.length) {
    const forumMirror = await dependencies.mirrorForumTopics({
      urls: newlyDiscoveredForumUrls,
      maxTopics: newlyDiscoveredForumUrls.length
    });

    if (forumMirrorNeedsRetry(forumMirror)) {
      throw new Error("A newly discovered Forum topic could not be fetched completely; retrying the event.");
    }

    const forumStored = await dependencies.storeMirrorResult(client, syncRunId, forumMirror);
    counts = addCounts(counts, forumStored.counts);
    forumUnavailable = forumMirrorUnavailable(forumMirror);
    forum = {
      requestedUrls: newlyDiscoveredForumUrls,
      snapshotKey: forumStored.snapshotKey,
      normalized: forumStored.normalizedForum,
      unavailable: forumUnavailable
    };
  }

  const knowledge = await scopedKnowledgeRefresh(
    [...previouslyLinkedApplicationIds, ...reconciliation.applicationIds],
    dependencies.refreshGrantKnowledgeDocuments
  );
  const requiresFullRefresh = reconciliation.requiresFullReconciliation || forumUnavailable;

  return {
    counts,
    metadata: {
      provider: "github",
      sourceKey: group.key,
      githubSourceId,
      targetStatus: mirror.target.status,
      snapshotKey: stored.snapshotKey,
      recordsDeleted,
      reconciliation,
      newlyDiscoveredForumUrls,
      forum,
      knowledge,
      requiresFullRefresh,
      fullRefreshReason: reconciliation.requiresFullReconciliation
        ? reconciliation.reason
        : forumUnavailable
          ? "forum_topic_unavailable"
          : null
    }
  };
}

async function processDiscourseGroup(
  client: QueryClient,
  syncRunId: string,
  group: MessageGroup,
  dependencies: Required<Pick<
    CorpusEventWorkerDependencies,
    "mirrorForumTopics" | "refreshGrantKnowledgeDocuments" | "storeMirrorResult"
  >>
): Promise<ProcessResult> {
  const message = group.entries.at(-1)!.message;

  if (message.provider !== "discourse") {
    throw new Error("Discourse event group contained a different provider.");
  }

  if (!message.source.topicId) {
    return {
      counts: { recordsSeen: group.entries.length, recordsCreated: 0, recordsUpdated: 0, recordsSkipped: group.entries.length },
      metadata: {
        provider: "discourse",
        sourceKey: group.key,
        requiresFullRefresh: true,
        fullRefreshReason: "discourse_event_has_no_topic"
      }
    };
  }

  const before = await knownForumTopicContext(client, message.source.topicId);
  if (!before.urls.length) {
    return {
      counts: {
        recordsSeen: group.entries.length,
        recordsCreated: 0,
        recordsUpdated: 0,
        recordsSkipped: group.entries.length
      },
      metadata: {
        provider: "discourse",
        sourceKey: group.key,
        topicId: message.source.topicId,
        ignored: true,
        reason: "unknown_topic",
        requiresFullRefresh: false
      }
    };
  }

  const urls = before.urls;
  const mirror = await dependencies.mirrorForumTopics({ urls, maxTopics: 1 });

  if (forumMirrorNeedsRetry(mirror)) {
    throw new Error(`Forum topic ${message.source.topicId} could not be fetched completely; retrying the event.`);
  }

  const stored = await dependencies.storeMirrorResult(client, syncRunId, mirror);
  const after = await knownForumTopicContext(client, message.source.topicId);
  const knowledge = await scopedKnowledgeRefresh(
    [...before.applicationIds, ...after.applicationIds],
    dependencies.refreshGrantKnowledgeDocuments
  );
  const unavailable = forumMirrorUnavailable(mirror);

  return {
    counts: stored.counts,
    metadata: {
      provider: "discourse",
      sourceKey: group.key,
      topicId: message.source.topicId,
      urls,
      snapshotKey: stored.snapshotKey,
      normalized: stored.normalizedForum,
      knowledge,
      requiresFullRefresh: unavailable,
      fullRefreshReason: unavailable ? "discourse_topic_unavailable" : null
    }
  };
}

async function processGroup(
  client: QueryClient,
  syncRunId: string,
  group: MessageGroup,
  dependencies: Required<Pick<
    CorpusEventWorkerDependencies,
    | "mirrorGitHubIssue"
    | "mirrorForumTopics"
    | "runTargetedGitHubReconciliation"
    | "refreshGrantKnowledgeDocuments"
    | "storeMirrorResult"
  >>
) {
  if (group.provider === "github") {
    return processGitHubGroup(client, syncRunId, group, dependencies);
  }

  if (group.provider === "discourse") {
    return processDiscourseGroup(client, syncRunId, group, dependencies);
  }

  const message = group.entries.at(-1)!.message;

  if (message.provider !== "google-drive") {
    throw new Error("Google Drive event group contained a different provider.");
  }

  return {
    counts: {
      recordsSeen: group.entries.length,
      recordsCreated: 0,
      recordsUpdated: 0,
      recordsSkipped: group.entries.length
    },
    metadata: {
      provider: "google-drive",
      sourceKey: group.key,
      channelId: message.source.channelId,
      fileId: message.source.fileId ?? null,
      resourceId: message.source.resourceId ?? null,
      resourceUri: message.source.resourceUri ?? null,
      action: message.action,
      requiresFullRefresh: true,
      fullRefreshReason: "google_drive_notification_requires_delta_sheet_sync"
    }
  } satisfies ProcessResult;
}

export function createCorpusEventHandler(dependencies: CorpusEventWorkerDependencies = {}) {
  const connect = dependencies.connect ?? defaultConnect;
  const now = dependencies.now ?? (() => new Date());
  const randomId = dependencies.randomId ?? randomUUID;
  const logError = dependencies.logError ?? console.error;
  const processingDependencies = {
    mirrorGitHubIssue: dependencies.mirrorGitHubIssue ?? mirrorGitHubIssue,
    mirrorForumTopics: dependencies.mirrorForumTopics ?? mirrorForumTopics,
    runTargetedGitHubReconciliation:
      dependencies.runTargetedGitHubReconciliation ?? defaultTargetedReconciliation,
    refreshGrantKnowledgeDocuments:
      dependencies.refreshGrantKnowledgeDocuments ?? defaultScopedKnowledgeRefresh,
    storeMirrorResult: dependencies.storeMirrorResult ?? defaultStoreMirrorResult
  };

  return async function corpusEventHandler(event: SqsEvent = {}): Promise<SqsBatchResponse> {
    const failures = new Set<string>();
    const entries: MessageEntry[] = [];

    for (const record of event.Records ?? []) {
      try {
        entries.push({ record, message: parseWebhookMessage(record.body) });
      } catch (error) {
        failures.add(record.messageId);
        logError("Corpus event message could not be parsed", {
          messageId: record.messageId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (!entries.length) {
      return {
        batchItemFailures: [...failures].map((itemIdentifier) => ({ itemIdentifier }))
      };
    }

    const client = await connect();

    try {
      for (const group of coalesceMessages(entries)) {
        const pipelineOwner = `corpus-event:${randomId()}`;
        const pipelineLease = await acquireCorpusEventPipelineLease(client, {
          owner: pipelineOwner,
          sourceKey: group.key,
          acquiredAt: now().toISOString()
        });

        if (!pipelineLease.acquired) {
          for (const entry of group.entries) failures.add(entry.record.messageId);
          logError("Corpus event deferred while the shared corpus pipeline lease is active", {
            sourceKey: group.key,
            busyOwnerKind: pipelineLease.ownerKind,
            lockedUntil: pipelineLease.lockedUntil
          });
          continue;
        }

        try {
          const claims: DeliveryClaim[] = [];
          const uniqueDeliveries = new Map<string, MessageEntry[]>();

          for (const entry of group.entries) {
            const matching = uniqueDeliveries.get(entry.message.deliveryId) ?? [];
            matching.push(entry);
            uniqueDeliveries.set(entry.message.deliveryId, matching);
          }

          for (const [deliveryId, deliveryEntries] of uniqueDeliveries) {
            const owner = randomId();
            const claim = await claimDelivery(client, {
              provider: group.provider,
              deliveryId,
              owner,
              now: now().toISOString(),
              sourceKey: group.key
            });

            if (claim.status === "acquired") {
              claims.push({
                key: claim.key,
                owner,
                deliveryId,
                entries: deliveryEntries
              });
            } else if (claim.status === "busy") {
              for (const entry of deliveryEntries) failures.add(entry.record.messageId);
            }
          }

          if (!claims.length) {
            continue;
          }

          const claimedMessageIds = claims.flatMap((claim) =>
            claim.entries.map((entry) => entry.record.messageId)
          );
          const claimedDeliveryIds = new Set(claims.map((claim) => claim.deliveryId));
          const claimedGroup: MessageGroup = {
            ...group,
            entries: group.entries.filter((entry) => claimedDeliveryIds.has(entry.message.deliveryId))
          };
          let syncRunId: string | null = null;

          try {
            syncRunId = await createSyncRun(client, claimedGroup);
            const result = await processGroup(
              client,
              syncRunId,
              claimedGroup,
              processingDependencies
            );
            await completeSyncRun(client, syncRunId, result);

            for (const claim of claims) {
              await finishDelivery(client, claim, {
                status: "completed",
                completedAt: now().toISOString(),
                syncRunId,
                sourceKey: group.key
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            if (syncRunId) {
              await failSyncRun(client, syncRunId, claimedGroup, error).catch((telemetryError) => {
                logError("Failed to record corpus event failure telemetry", telemetryError);
              });
            }

            for (const claim of claims) {
              await finishDelivery(client, claim, {
                status: "failed",
                completedAt: now().toISOString(),
                syncRunId,
                sourceKey: group.key,
                error: message
              }).catch((idempotencyError) => {
                logError("Failed to release corpus event delivery claim", idempotencyError);
              });
            }

            for (const messageId of claimedMessageIds) failures.add(messageId);
            logError("Corpus event processing failed", {
              sourceKey: group.key,
              syncRunId,
              error: message
            });
          }
        } finally {
          const released = await releaseCorpusEventPipelineLease(client, pipelineOwner);

          if (!released) {
            logError("Corpus event pipeline lease was not owned at release time", {
              sourceKey: group.key,
              pipelineOwner
            });
          }
        }
      }
    } finally {
      await client.end();
    }

    return {
      batchItemFailures: [...failures].map((itemIdentifier) => ({ itemIdentifier }))
    };
  };
}

export const handler = createCorpusEventHandler();

export const corpusEventWorkerTestHooks = {
  acquireCorpusEventPipelineLease,
  applyTargetedCleanup,
  claimDelivery,
  coalesceMessages,
  deliveryIdempotencyKey,
  groupKey,
  knownForumTopicContext,
  parseWebhookMessage,
  releaseCorpusEventPipelineLease,
  scopedKnowledgeRefresh,
  unmirroredForumUrls
};
