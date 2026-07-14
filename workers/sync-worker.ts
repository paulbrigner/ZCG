import crypto from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import pg from "pg";
import { workerDatabaseUrl } from "../lib/worker-db-url";
import { collectSourceMirrors, type SourceMirrorEvent, type SourceMirrorResult } from "../lib/source-mirroring";
import { forumTopicUrlsFromSourceRecords } from "../lib/source-mirroring/forum";
import {
  addCounts,
  emptyCounts,
  recordSourceSnapshot,
  upsertSourceRecords,
  type SnapshotReference,
  type StoreCounts
} from "../lib/source-mirroring/store";
import {
  backfillNormalizedForumRecords,
  storeNormalizedForumRecords,
  type NormalizedForumStoreCounts
} from "../lib/source-mirroring/forum-store";

const { Client } = pg;
const s3 = new S3Client({});
const lambda = new LambdaClient({});
const CORPUS_REFRESH_LOCK_NAME = "zcg:corpus-refresh-reconciliation:v1";

type WorkerEvent = SourceMirrorEvent & {
  dryRun?: boolean;
  reconcile?: boolean;
  rebuildKnowledgeIndex?: boolean;
  backfillLimit?: number;
  batchIndex?: number;
  batchSize?: number;
  refreshId?: string;
  parentSyncRunId?: string;
  trigger?: "admin" | "schedule" | "manual";
  errorSummary?: string;
  requestedAt?: string;
  requestedByPrincipalId?: string | null;
};

type RefreshLeaseResult = {
  acquired: boolean;
  refreshId: string;
  parentSyncRunId: string | null;
  message?: string;
};

const CORPUS_REFRESH_LEASE_KEY = "corpus-refresh:pipeline:v1";
const CORPUS_REFRESH_LEASE_SCOPE = "corpus-refresh";
const CORPUS_REFRESH_LEASE_HOURS = 4;
const FORUM_URL_CHUNK_PREFIX = "source-mirrors/orchestrations";

function requiresCorpusRefreshLock(source: string, event: WorkerEvent) {
  return source === "reconcile-grants" || (source === "phase1-all" && event.reconcile === true);
}

async function tryAcquireCorpusRefreshLock(client: pg.Client) {
  const result = await client.query<{ acquired: boolean }>(
    `select pg_try_advisory_lock(hashtextextended($1::text, 0)) as acquired`,
    [CORPUS_REFRESH_LOCK_NAME]
  );

  return result.rows[0]?.acquired === true;
}

async function releaseCorpusRefreshLock(client: pg.Client) {
  const result = await client.query<{ released: boolean }>(
    `select pg_advisory_unlock(hashtextextended($1::text, 0)) as released`,
    [CORPUS_REFRESH_LOCK_NAME]
  );

  return result.rows[0]?.released === true;
}

async function recordBusySyncRun(client: pg.Client, source: string, event: WorkerEvent) {
  const message = "Skipped because another full corpus refresh or grant reconciliation is already running.";
  const metadata = {
    phase: "single_flight",
    busy: true,
    skipped: true,
    lockName: CORPUS_REFRESH_LOCK_NAME,
    requestedAt: event.requestedAt ?? null,
    requestedByPrincipalId: event.requestedByPrincipalId ?? null
  };
  const result = await client.query<{ id: string }>(
    `insert into sync_runs (source, status, error_summary, metadata, started_at, completed_at)
     values ($1, 'cancelled', $2, $3::jsonb, now(), now())
     returning id`,
    [source, message, JSON.stringify(metadata)]
  );
  const syncRunId = result.rows[0]?.id;

  if (!syncRunId) {
    throw new Error("Failed to record skipped sync run");
  }

  try {
    await client.query(
      `insert into audit_events (action, target_type, target_id, metadata)
       values ('sync_worker.skipped_busy', 'sync_run', $1, $2::jsonb)`,
      [syncRunId, JSON.stringify({ source, ...metadata })]
    );
  } catch (error) {
    // The cancelled sync run is the durable busy outcome. Do not turn it into
    // a failed run if secondary audit persistence is temporarily unavailable.
    console.error("Failed to record busy sync worker audit event", { error, syncRunId });
  }

  return {
    ok: true,
    syncRunId,
    source,
    skipped: true,
    busy: true,
    message
  };
}

function requireRefreshId(event: WorkerEvent) {
  const refreshId = event.refreshId?.trim();

  if (!refreshId) {
    throw new Error("A refreshId is required for the staged corpus refresh pipeline.");
  }

  return safeSnapshotSegment(refreshId);
}

function metadataCount(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function stagedMirrorWarnings(results: SourceMirrorResult[]) {
  const warnings: string[] = [];
  let warningCount = 0;

  for (const result of results) {
    const unavailable = metadataCount(result.metadata, "topicCountUnavailable");
    const partial = metadataCount(result.metadata, "topicCountPartial");

    if (unavailable > 0) {
      warningCount += unavailable;
      warnings.push(`${result.sourceKind}: ${unavailable} topic(s) were unavailable or not public.`);
    }

    if (partial > 0) {
      warningCount += partial;
      warnings.push(`${result.sourceKind}: ${partial} topic(s) had partial post coverage.`);
    }
  }

  return { warningCount, warnings };
}

function assertStagedMirrorComplete(event: WorkerEvent, results: SourceMirrorResult[]) {
  if (!event.refreshId) {
    return;
  }

  const blockers: string[] = [];

  for (const result of results) {
    const rateLimitedAt = result.metadata?.rateLimitedAt;
    const categoryFailureCount = metadataCount(result.metadata, "categoryFailureCount");
    const topicErrorCount = metadataCount(result.metadata, "topicErrorCount");

    if (typeof rateLimitedAt === "string" && rateLimitedAt) {
      blockers.push(`${result.sourceKind} was rate-limited at ${rateLimitedAt}`);
    }

    if (categoryFailureCount > 0) {
      blockers.push(`${result.sourceKind} had ${categoryFailureCount} category discovery error(s)`);
    }

    if (topicErrorCount > 0) {
      blockers.push(`${result.sourceKind} had ${topicErrorCount} topic fetch error(s)`);
    }
  }

  if (blockers.length > 0) {
    throw new Error(`The staged source mirror was incomplete: ${blockers.join("; ")}.`);
  }
}

async function acquireCorpusRefreshLease(
  client: pg.Client,
  event: WorkerEvent
): Promise<RefreshLeaseResult> {
  const refreshId = requireRefreshId(event);

  await client.query("begin");

  try {
    const existingLease = await client.query<{
      result: Record<string, unknown> | null;
      reclaimable: boolean;
    }>(
      `select result,
              (locked_until is null or locked_until < now()) as reclaimable
         from idempotency_keys
        where key = $1
        for update`,
      [CORPUS_REFRESH_LEASE_KEY]
    );
    const previousLeaseResult = existingLease.rows[0]?.result ?? {};
    const previousOwner = previousLeaseResult.owner;
    const previousParentSyncRunId = previousLeaseResult.parentSyncRunId;

    const claimed = await client.query<{ result: Record<string, unknown> }>(
      `insert into idempotency_keys (key, scope, locked_until, result, created_at, updated_at)
       values (
         $1,
         $2,
         now() + ($3::int * interval '1 hour'),
         jsonb_build_object(
           'owner', $4::text,
           'trigger', $5::text,
           'requestedAt', $6::text,
           'requestedByPrincipalId', $7::text
         ),
         now(),
         now()
       )
       on conflict (key) do update
         set scope = excluded.scope,
             locked_until = excluded.locked_until,
             result = case
               when idempotency_keys.result->>'owner' = $4::text
                 then coalesce(idempotency_keys.result, '{}'::jsonb) || excluded.result
               else excluded.result
             end,
             updated_at = now()
       where idempotency_keys.locked_until is null
          or idempotency_keys.locked_until < now()
          or idempotency_keys.result->>'owner' = $4::text
       returning result`,
      [
        CORPUS_REFRESH_LEASE_KEY,
        CORPUS_REFRESH_LEASE_SCOPE,
        CORPUS_REFRESH_LEASE_HOURS,
        refreshId,
        event.trigger ?? "manual",
        event.requestedAt ?? new Date().toISOString(),
        event.requestedByPrincipalId ?? null
      ]
    );

    if (!claimed.rowCount) {
      await client.query("rollback");
      return {
        acquired: false,
        refreshId,
        parentSyncRunId: null,
        message: "Another full corpus refresh is already running."
      };
    }

    if (
      existingLease.rows[0]?.reclaimable === true &&
      previousOwner !== refreshId &&
      typeof previousParentSyncRunId === "string" &&
      previousParentSyncRunId
    ) {
      await client.query(
        `update sync_runs
            set status = 'failed',
                error_summary = coalesce(
                  error_summary,
                  'The previous corpus refresh lease expired before the workflow finalized.'
                ),
                metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                  'staleLeaseRecoveredByRefreshId', $2::text,
                  'staleLeaseOwner', $3::text,
                  'staleLeaseRecoveredAt', now()
                ),
                completed_at = coalesce(completed_at, now())
          where id = $1
            and status = 'running'`,
        [
          previousParentSyncRunId,
          refreshId,
          typeof previousOwner === "string" ? previousOwner : null
        ]
      );
    }

    const existingParentSyncRunId = claimed.rows[0]?.result?.parentSyncRunId;
    let parentSyncRunId =
      typeof existingParentSyncRunId === "string" && existingParentSyncRunId
        ? existingParentSyncRunId
        : null;

    if (!parentSyncRunId) {
      const parent = await client.query<{ id: string }>(
        `insert into sync_runs (source, status, metadata, started_at)
         values (
           'phase1-all',
           'running',
           jsonb_build_object(
             'phase', 'corpus_refresh_pipeline',
             'refreshId', $1::text,
             'trigger', $2::text,
             'requestedAt', $3::text,
             'requestedByPrincipalId', $4::text
           ),
           now()
         )
         returning id`,
        [
          refreshId,
          event.trigger ?? "manual",
          event.requestedAt ?? new Date().toISOString(),
          event.requestedByPrincipalId ?? null
        ]
      );
      parentSyncRunId = parent.rows[0]?.id ?? null;

      if (!parentSyncRunId) {
        throw new Error("Failed to create the parent corpus refresh sync run.");
      }

      await client.query(
        `update idempotency_keys
            set result = coalesce(result, '{}'::jsonb) || jsonb_build_object('parentSyncRunId', $2::text),
                updated_at = now()
          where key = $1
            and result->>'owner' = $3::text`,
        [CORPUS_REFRESH_LEASE_KEY, parentSyncRunId, refreshId]
      );
    }

    await client.query("commit");
    return { acquired: true, refreshId, parentSyncRunId };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function releaseCorpusRefreshLease(
  client: pg.Client,
  event: WorkerEvent,
  status: "completed" | "failed"
) {
  const refreshId = requireRefreshId(event);
  const lease = await client.query<{ result: Record<string, unknown> }>(
    `select result
       from idempotency_keys
      where key = $1
        and result->>'owner' = $2`,
    [CORPUS_REFRESH_LEASE_KEY, refreshId]
  );
  const storedParentSyncRunId = lease.rows[0]?.result?.parentSyncRunId;
  const storedRequestedAt = lease.rows[0]?.result?.requestedAt;
  const storedRequestedByPrincipalId = lease.rows[0]?.result?.requestedByPrincipalId;
  const parentSyncRunId =
    event.parentSyncRunId ??
    (typeof storedParentSyncRunId === "string" ? storedParentSyncRunId : null);

  if (!parentSyncRunId) {
    throw new Error("The corpus refresh parent sync run could not be resolved.");
  }

  const totals = await client.query<{
    records_seen: string;
    records_created: string;
    records_updated: string;
    records_skipped: string;
    warning_count: string;
  }>(
    `select coalesce(sum(records_seen), 0)::text as records_seen,
            coalesce(sum(records_created), 0)::text as records_created,
            coalesce(sum(records_updated), 0)::text as records_updated,
            coalesce(sum(records_skipped), 0)::text as records_skipped,
            coalesce(
              sum(
                case
                  when metadata->>'warningCount' ~ '^[0-9]+$'
                    then (metadata->>'warningCount')::integer
                  else 0
                end
              ),
              0
            )::text as warning_count
       from sync_runs
      where metadata->>'parentSyncRunId' = $1
        and status = 'completed'`,
    [parentSyncRunId]
  );
  const row = totals.rows[0];
  const counts = {
    recordsSeen: Number(row?.records_seen ?? 0),
    recordsCreated: Number(row?.records_created ?? 0),
    recordsUpdated: Number(row?.records_updated ?? 0),
    recordsSkipped: Number(row?.records_skipped ?? 0)
  };
  const warningCount = Number(row?.warning_count ?? 0);
  const metadata = {
    phase: "corpus_refresh_pipeline",
    refreshId,
    trigger: event.trigger ?? "manual",
    requestedAt:
      event.requestedAt ?? (typeof storedRequestedAt === "string" ? storedRequestedAt : null),
    requestedByPrincipalId:
      event.requestedByPrincipalId ??
      (typeof storedRequestedByPrincipalId === "string" ? storedRequestedByPrincipalId : null),
    childCounts: counts,
    warningCount
  };

  await client.query(
    `update sync_runs
        set status = $2,
            records_seen = $3,
            records_created = $4,
            records_updated = $5,
            records_skipped = $6,
            metadata = coalesce(metadata, '{}'::jsonb) || $7::jsonb,
            error_summary = $8,
            completed_at = now()
      where id = $1`,
    [
      parentSyncRunId,
      status,
      counts.recordsSeen,
      counts.recordsCreated,
      counts.recordsUpdated,
      counts.recordsSkipped,
      JSON.stringify(metadata),
      status === "failed"
        ? event.errorSummary ?? "The staged corpus refresh failed."
        : warningCount > 0
          ? `Completed with ${warningCount} source coverage warning(s).`
          : null
    ]
  );
  await client.query(
    `delete from idempotency_keys
      where key = $1
        and result->>'owner' = $2`,
    [CORPUS_REFRESH_LEASE_KEY, refreshId]
  );
  try {
    await client.query(
      `insert into audit_events (action, target_type, target_id, metadata)
       values ($1, 'sync_run', $2, $3::jsonb)`,
      [
        status === "completed"
          ? "sync_worker.corpus_refresh.completed"
          : "sync_worker.corpus_refresh.failed",
        parentSyncRunId,
        JSON.stringify(metadata)
      ]
    );
  } catch (error) {
    console.error("Corpus refresh telemetry was finalized, but its audit event could not be recorded", {
      error,
      parentSyncRunId,
      refreshId,
      status
    });
  }

  return { ok: status === "completed", status, refreshId, parentSyncRunId, warningCount, ...counts };
}

function refreshObjectKey(refreshId: string, suffix: string) {
  return `${FORUM_URL_CHUNK_PREFIX}/${safeSnapshotSegment(refreshId)}/${suffix}`;
}

function snapshotBucketName() {
  const bucket = process.env.SNAPSHOT_BUCKET_NAME;

  if (!bucket) {
    throw new Error("SNAPSHOT_BUCKET_NAME is required for staged corpus refresh manifests.");
  }

  return bucket;
}

async function putRefreshJson(refreshId: string, suffix: string, payload: unknown) {
  const bucket = snapshotBucketName();
  const key = refreshObjectKey(refreshId, suffix);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(payload),
      ContentType: "application/json",
      ServerSideEncryption: "AES256"
    })
  );

  return { bucket, key };
}

async function getRefreshJson<T>(bucket: string, key: string): Promise<T> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await response.Body?.transformToString();

  if (!body) {
    throw new Error(`Corpus refresh manifest ${key} is empty.`);
  }

  return JSON.parse(body) as T;
}

async function writeForumUrlChunk(
  refreshId: string,
  chunkName: string,
  results: SourceMirrorResult[]
) {
  const urls = forumTopicUrlsFromSourceRecords(results.flatMap((result) => result.records));
  const location = await putRefreshJson(refreshId, `forum-url-chunks/${safeSnapshotSegment(chunkName)}.json`, {
    urls
  });

  return { ...location, urlCount: urls.length };
}

async function buildForumUrlManifest(refreshId: string, batchSize: number) {
  const bucket = snapshotBucketName();
  const prefix = refreshObjectKey(refreshId, "forum-url-chunks/");
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken })
    );
    keys.push(...(listed.Contents ?? []).flatMap((item) => (item.Key ? [item.Key] : [])));
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  const urls = new Set<string>();

  for (const key of keys.sort()) {
    const chunk = await getRefreshJson<{ urls?: string[] }>(bucket, key);

    for (const url of chunk.urls ?? []) {
      urls.add(url);
    }
  }

  const selectedUrls = [...urls].sort((left, right) => left.localeCompare(right));
  const location = await putRefreshJson(refreshId, "forum-url-manifest.json", { urls: selectedUrls });
  const batchCount = Math.ceil(selectedUrls.length / batchSize);

  return {
    ...location,
    topicCount: selectedUrls.length,
    batchSize,
    batchIndexes: Array.from({ length: batchCount }, (_, index) => index)
  };
}

async function loadManifestBatch(params: {
  bucket: string;
  key: string;
  batchIndex: number;
  batchSize: number;
}) {
  const manifest = await getRefreshJson<{ urls?: string[] }>(params.bucket, params.key);
  const urls = manifest.urls ?? [];
  const start = params.batchIndex * params.batchSize;

  return urls.slice(start, start + params.batchSize);
}

async function enqueueKnowledgeIndexRebuild(event: WorkerEvent, reconciliationCompleted: boolean) {
  if (!event.rebuildKnowledgeIndex) {
    return null;
  }

  if (!reconciliationCompleted) {
    throw new Error("Knowledge index rebuild after source mirroring requires reconciliation.");
  }

  const functionName = process.env.ZCG_KNOWLEDGE_INDEX_WORKER_FUNCTION_NAME;

  if (!functionName) {
    throw new Error("ZCG_KNOWLEDGE_INDEX_WORKER_FUNCTION_NAME is not configured.");
  }

  const payload = {
    requestedAt: event.requestedAt ?? new Date().toISOString(),
    requestedByPrincipalId: event.requestedByPrincipalId ?? null
  };
  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload))
    })
  );

  if (result.StatusCode && result.StatusCode >= 300) {
    throw new Error(`Knowledge index worker invoke failed with status ${result.StatusCode}.`);
  }

  return {
    functionName,
    invocationStatusCode: result.StatusCode ?? null
  };
}

function safeSnapshotSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._=-]+/g, "-").slice(0, 160);
}

async function putSnapshot(params: {
  syncRunId: string;
  source: string;
  sourceId?: string;
  payload: Record<string, unknown>;
}): Promise<SnapshotReference | null> {
  const bucket = process.env.SNAPSHOT_BUCKET_NAME;

  if (!bucket) {
    return null;
  }

  const body = JSON.stringify(params.payload, null, 2);
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const sourceId = params.sourceId ? `/${safeSnapshotSegment(params.sourceId)}` : "";
  const key = `source-mirrors/${safeSnapshotSegment(params.source)}${sourceId}/${params.syncRunId}.json`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
      Metadata: {
        checksum
      }
    })
  );

  return { bucket, key, checksum };
}

async function createSyncRun(client: pg.Client, source: string) {
  const started = await client.query<{ id: string }>(
    `insert into sync_runs (source, status, started_at)
     values ($1, 'running', now())
     returning id`,
    [source]
  );

  const syncRunId = started.rows[0]?.id;

  if (!syncRunId) {
    throw new Error("Failed to create sync run");
  }

  return syncRunId;
}

async function completeSyncRun(
  client: pg.Client,
  params: {
    syncRunId: string;
    counts: StoreCounts;
    metadata: Record<string, unknown>;
  }
) {
  await client.query(
    `update sync_runs
        set status = 'completed',
            records_seen = $2,
            records_created = $3,
            records_updated = $4,
            records_skipped = $5,
            metadata = $6::jsonb,
            completed_at = now()
      where id = $1`,
    [
      params.syncRunId,
      params.counts.recordsSeen,
      params.counts.recordsCreated,
      params.counts.recordsUpdated,
      params.counts.recordsSkipped,
      JSON.stringify(params.metadata)
    ]
  );
}

async function failSyncRun(client: pg.Client, syncRunId: string | null, source: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  if (syncRunId) {
    await client.query(
      `update sync_runs
          set status = 'failed',
              error_summary = $2,
              completed_at = now()
        where id = $1`,
      [syncRunId, message]
    );
    return;
  }

  await client.query(
    `insert into sync_runs (source, status, error_summary, started_at, completed_at)
     values ($1, 'failed', $2, now(), now())`,
    [source, message]
  );
}

async function runPhase0Skeleton(client: pg.Client, syncRunId: string, event: WorkerEvent) {
  const source = event.source ?? "phase0";
  const snapshot = await putSnapshot({
    syncRunId,
    source,
    payload: {
      phase: 0,
      source,
      dryRun: event.dryRun ?? true,
      capturedAt: new Date().toISOString(),
      message: "Phase 0 worker skeleton executed successfully."
    }
  });

  if (snapshot) {
    await client.query(
      `insert into source_snapshots (
         sync_run_id,
         source_kind,
         source_id,
         s3_bucket,
         s3_key,
         checksum_sha256
       )
       values ($1, $2, $3, $4, $5, $6)
       on conflict (source_kind, source_id, checksum_sha256) do nothing`,
      [syncRunId, source, `phase0:${syncRunId}`, snapshot.bucket, snapshot.key, snapshot.checksum]
    );
  }

  const counts = { ...emptyCounts };
  await completeSyncRun(client, {
    syncRunId,
    counts,
    metadata: {
      phase: 0,
      dryRun: event.dryRun ?? true,
      snapshotKey: snapshot?.key ?? null
    }
  });

  await client.query(
    `insert into audit_events (action, target_type, target_id, metadata)
     values ('sync_worker.completed', 'sync_run', $1, $2::jsonb)`,
    [syncRunId, JSON.stringify({ source, phase: 0, snapshotKey: snapshot?.key ?? null })]
  );

  return { ok: true, syncRunId, snapshotKey: snapshot?.key ?? null };
}

async function storeMirrorResult(
  client: pg.Client,
  syncRunId: string,
  result: SourceMirrorResult
): Promise<StoreCounts & { snapshotKey: string | null; normalizedForum: NormalizedForumStoreCounts }> {
  const snapshot = await putSnapshot({
    syncRunId,
    source: result.sourceKind,
    sourceId: result.sourceId,
    payload: result.rawPayload
  });
  const rawSnapshotId = await recordSourceSnapshot(client, { syncRunId, result, snapshot });
  const counts = await upsertSourceRecords(client, result.records, rawSnapshotId);
  const normalizedForum = await storeNormalizedForumRecords(client, {
    syncRunId,
    records: result.records
  });

  return { ...counts, snapshotKey: snapshot?.key ?? null, normalizedForum };
}

async function runForumNormalizationBackfill(
  client: pg.Client,
  syncRunId: string,
  event: WorkerEvent
) {
  const normalized = await backfillNormalizedForumRecords(client, {
    syncRunId,
    limit: event.backfillLimit
  });
  const counts: StoreCounts = {
    recordsSeen: normalized.recordsSeen,
    recordsCreated: 0,
    recordsUpdated: normalized.recordsEligible,
    recordsSkipped: normalized.recordsSeen - normalized.recordsEligible
  };

  await completeSyncRun(client, {
    syncRunId,
    counts,
    metadata: {
      phase: "forum_normalization_backfill",
      normalized
    }
  });

  await client.query(
    `insert into audit_events (action, target_type, target_id, metadata)
     values ('sync_worker.forum_normalization.completed', 'sync_run', $1, $2::jsonb)`,
    [syncRunId, JSON.stringify(normalized)]
  );

  return { ok: true, syncRunId, ...counts, normalized };
}

async function runForumCompletionBackfill(
  client: pg.Client,
  syncRunId: string,
  event: WorkerEvent
) {
  const limit = Math.min(50, Math.max(1, event.backfillLimit ?? 25));
  const configuredMaxCompletablePosts = Number(
    process.env.ZCG_FORUM_MAX_POSTS_PER_LINKED_TOPIC ?? 1000
  );
  const maxCompletablePosts = Number.isFinite(configuredMaxCompletablePosts)
    ? Math.max(1, Math.floor(configuredMaxCompletablePosts))
    : 1000;
  const pending = await client.query<{ id: string; canonical_url: string }>(
    `select id, canonical_url
       from discourse_topics
      where coverage_complete = false
        and (coverage_capped = false or stream_post_count <= $2)
        and exists (
          select 1
            from discourse_topic_references dtr
            join source_records sr on sr.id = dtr.source_record_id
            join source_links sl on sl.source_record_id = sr.id
           where dtr.discourse_topic_id = discourse_topics.id
             and sr.source_kind = 'forum_link'
             and sl.canonical_type = 'grant_application'
        )
      order by coalesce((metadata->>'completionLastAttemptAt')::timestamptz, 'epoch'::timestamptz),
               last_posted_at desc nulls last,
               topic_id
      limit $1`,
    [limit, maxCompletablePosts]
  );

  if (!pending.rows.length) {
    const capped = await client.query<{ count: string }>(
      `select count(*)::text as count
         from discourse_topics
        where coverage_complete = false
          and coverage_capped = true
          and stream_post_count > $1
          and exists (
            select 1
              from discourse_topic_references dtr
              join source_records sr on sr.id = dtr.source_record_id
              join source_links sl on sl.source_record_id = sr.id
             where dtr.discourse_topic_id = discourse_topics.id
               and sr.source_kind = 'forum_link'
               and sl.canonical_type = 'grant_application'
          )`,
      [maxCompletablePosts]
    );
    const topicsCapped = Number(capped.rows[0]?.count ?? 0);

    await completeSyncRun(client, {
      syncRunId,
      counts: { ...emptyCounts },
      metadata: {
        phase: "forum_completion_backfill",
        complete: true,
        topicsAttempted: 0,
        topicsRemaining: 0,
        topicsCapped
      }
    });
    return {
      ok: true,
      syncRunId,
      ...emptyCounts,
      complete: true,
      topicsAttempted: 0,
      topicsRemaining: 0,
      topicsCapped
    };
  }

  const [result] = await collectSourceMirrors({
    source: "forum-topics",
    forum: {
      ...event.forum,
      urls: pending.rows.map((row) => row.canonical_url)
    }
  });
  let counts = { ...emptyCounts };
  let sourceSummary: Record<string, unknown> | null = null;

  if (result) {
    const stored = await storeMirrorResult(client, syncRunId, result);
    counts = addCounts(counts, stored);
    sourceSummary = {
      sourceKind: result.sourceKind,
      sourceId: result.sourceId,
      recordCount: result.records.length,
      snapshotKey: stored.snapshotKey,
      normalizedForum: stored.normalizedForum,
      metadata: result.metadata ?? {}
    };
  }

  await client.query(
    `update discourse_topics
        set metadata = metadata || jsonb_build_object(
              'completionLastAttemptAt', now(),
              'completionLastSyncRunId', $2::text
            ),
            updated_at = now()
      where id = any($1::uuid[])`,
    [pending.rows.map((row) => row.id), syncRunId]
  );

  const remaining = await client.query<{ count: string }>(
    `select count(*)::text as count
       from discourse_topics
      where coverage_complete = false
        and (coverage_capped = false or stream_post_count <= $1)
        and exists (
          select 1
            from discourse_topic_references dtr
            join source_records sr on sr.id = dtr.source_record_id
            join source_links sl on sl.source_record_id = sr.id
           where dtr.discourse_topic_id = discourse_topics.id
             and sr.source_kind = 'forum_link'
             and sl.canonical_type = 'grant_application'
        )`,
    [maxCompletablePosts]
  );
  const capped = await client.query<{ count: string }>(
    `select count(*)::text as count
       from discourse_topics
      where coverage_complete = false
        and coverage_capped = true
        and stream_post_count > $1
        and exists (
          select 1
            from discourse_topic_references dtr
            join source_records sr on sr.id = dtr.source_record_id
            join source_links sl on sl.source_record_id = sr.id
           where dtr.discourse_topic_id = discourse_topics.id
             and sr.source_kind = 'forum_link'
             and sl.canonical_type = 'grant_application'
        )`,
    [maxCompletablePosts]
  );
  const topicsRemaining = Number(remaining.rows[0]?.count ?? 0);
  const topicsCapped = Number(capped.rows[0]?.count ?? 0);
  const metadata = {
    phase: "forum_completion_backfill",
    complete: topicsRemaining === 0,
    batchLimit: limit,
    topicsAttempted: pending.rows.length,
    topicsRemaining,
    topicsCapped,
    source: sourceSummary
  };

  await completeSyncRun(client, { syncRunId, counts, metadata });
  await client.query(
    `insert into audit_events (action, target_type, target_id, metadata)
     values ('sync_worker.forum_completion.completed', 'sync_run', $1, $2::jsonb)`,
    [syncRunId, JSON.stringify(metadata)]
  );

  return { ok: true, syncRunId, ...counts, ...metadata };
}

async function existingForumUpdateSourceIds(client: pg.Client) {
  const result = await client.query<{ source_id: string }>(
    `select source_id
       from source_records
      where source_kind in ('forum_meeting_minutes', 'forum_update_topic')`
  );

  return result.rows.map((row) => row.source_id);
}

async function sourceEventWithResumeSkips(client: pg.Client, event: WorkerEvent): Promise<WorkerEvent> {
  if (!event.forum?.skipExistingSourceRecords) {
    return event;
  }

  const skipUrls = [
    ...(event.forum.skipUrls ?? []),
    ...(await existingForumUpdateSourceIds(client))
  ];

  return {
    ...event,
    forum: {
      ...event.forum,
      skipUrls
    }
  };
}

async function runGrantReconciliationForWorker(client: pg.Client, syncRunId: string, source: string) {
  process.env.DATABASE_DRIVER = "pg";
  process.env.DATABASE_URL = await workerDatabaseUrl();

  const { ReconciliationBusyError, runGrantReconciliation } = await import("../lib/reconciliation/grants");
  let result;

  try {
    result = await runGrantReconciliation({ syncRunId });
  } catch (error) {
    if (error instanceof ReconciliationBusyError) {
      return {
        ok: false as const,
        busy: true as const,
        skipped: true as const,
        message: error.message,
        lockedUntil: error.lockedUntil
      };
    }

    throw error;
  }

  await client.query(
    `insert into audit_events (action, target_type, target_id, metadata)
     values ('sync_worker.reconciliation.completed', 'sync_run', $1, $2::jsonb)`,
    [syncRunId, JSON.stringify({ source, result })]
  );

  return result;
}

function reconciliationWasBusy(
  result: Awaited<ReturnType<typeof runGrantReconciliationForWorker>>
): result is {
  ok: false;
  busy: true;
  skipped: true;
  message: string;
  lockedUntil: string | null;
} {
  return "busy" in result && result.busy === true;
}

async function cancelSyncRunForBusyReconciliation(
  client: pg.Client,
  params: {
    syncRunId: string;
    source: string;
    counts: StoreCounts;
    reconciliation: {
      message: string;
      lockedUntil: string | null;
    };
    metadata?: Record<string, unknown>;
  }
) {
  const metadata = {
    phase: "reconciliation",
    busy: true,
    skipped: true,
    lockedUntil: params.reconciliation.lockedUntil,
    ...(params.metadata ?? {})
  };

  await client.query(
    `update sync_runs
        set status = 'cancelled',
            records_seen = $2,
            records_created = $3,
            records_updated = $4,
            records_skipped = $5,
            error_summary = $6,
            metadata = $7::jsonb,
            completed_at = now()
      where id = $1`,
    [
      params.syncRunId,
      params.counts.recordsSeen,
      params.counts.recordsCreated,
      params.counts.recordsUpdated,
      params.counts.recordsSkipped,
      params.reconciliation.message,
      JSON.stringify(metadata)
    ]
  );

  return {
    ok: true,
    syncRunId: params.syncRunId,
    source: params.source,
    busy: true,
    skipped: true,
    message: params.reconciliation.message,
    lockedUntil: params.reconciliation.lockedUntil
  };
}

export async function handler(event: WorkerEvent = {}) {
  const source = event.source ?? "phase1-all";
  const client = new Client({
    connectionString: await workerDatabaseUrl(),
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined
  });

  await client.connect();
  let syncRunId: string | null = null;
  let corpusRefreshLockAcquired = false;

  try {
    if (source === "corpus-refresh-acquire") {
      return await acquireCorpusRefreshLease(client, event);
    }

    if (source === "corpus-refresh-complete") {
      return await releaseCorpusRefreshLease(client, event, "completed");
    }

    if (source === "corpus-refresh-fail") {
      return await releaseCorpusRefreshLease(client, event, "failed");
    }

    if (requiresCorpusRefreshLock(source, event)) {
      corpusRefreshLockAcquired = await tryAcquireCorpusRefreshLock(client);

      if (!corpusRefreshLockAcquired) {
        return await recordBusySyncRun(client, source, event);
      }
    }

    syncRunId = await createSyncRun(client, source);

    if (source.startsWith("phase0")) {
      return await runPhase0Skeleton(client, syncRunId, event);
    }

    if (source === "reconcile-grants") {
      const reconciliation = await runGrantReconciliationForWorker(client, syncRunId, source);

      if (reconciliationWasBusy(reconciliation)) {
        return await cancelSyncRunForBusyReconciliation(client, {
          syncRunId,
          source,
          counts: { ...emptyCounts },
          reconciliation,
          metadata: {
            parentSyncRunId: event.parentSyncRunId ?? null,
            refreshId: event.refreshId ?? null
          }
        });
      }

      const knowledgeIndex = await enqueueKnowledgeIndexRebuild(event, true);

      await completeSyncRun(client, {
        syncRunId,
        counts: { ...emptyCounts },
        metadata: {
          phase: "reconciliation",
          dryRun: event.dryRun ?? false,
          parentSyncRunId: event.parentSyncRunId ?? null,
          refreshId: event.refreshId ?? null,
          reconciliation,
          knowledgeIndex
        }
      });

      return { ok: true, busy: false, syncRunId, reconciliation, knowledgeIndex };
    }

    if (source === "forum-normalize-backfill") {
      return await runForumNormalizationBackfill(client, syncRunId, event);
    }

    if (source === "forum-complete-backfill") {
      return await runForumCompletionBackfill(client, syncRunId, event);
    }

    const batchSize = Math.min(100, Math.max(1, Math.floor(event.batchSize ?? 20)));

    if (source === "forum-url-plan") {
      const refreshId = requireRefreshId(event);
      const plan = await buildForumUrlManifest(refreshId, batchSize);
      const metadata = {
        phase: "forum_url_plan",
        parentSyncRunId: event.parentSyncRunId ?? null,
        refreshId,
        plan
      };

      await completeSyncRun(client, { syncRunId, counts: { ...emptyCounts }, metadata });
      return { ok: true, syncRunId, ...metadata, ...plan };
    }

    let effectiveEvent: WorkerEvent = event;

    if (source === "github-issues-batch") {
      effectiveEvent = {
        ...event,
        source: "github-issues",
        github: {
          ...event.github,
          startPage: Math.max(1, Math.floor(event.batchIndex ?? 1)),
          pageSize: batchSize,
          maxPages: 1
        }
      };
    } else if (source === "forum-topics-batch" || source === "forum-updates-batch") {
      const refreshId = requireRefreshId(event);
      const manifestName =
        source === "forum-topics-batch" ? "forum-url-manifest.json" : "forum-updates-manifest.json";
      const urls = await loadManifestBatch({
        bucket: snapshotBucketName(),
        key: refreshObjectKey(refreshId, manifestName),
        batchIndex: Math.max(0, Math.floor(event.batchIndex ?? 0)),
        batchSize
      });
      effectiveEvent = {
        ...event,
        source: source === "forum-topics-batch" ? "forum-topics" : "forum-updates",
        forum: { ...event.forum, urls }
      };
    } else if (source === "forum-updates-plan") {
      effectiveEvent = {
        ...event,
        source: "forum-updates",
        forum: { ...event.forum, discoveryOnly: true }
      };
    }

    const mirrorEvent = await sourceEventWithResumeSkips(client, effectiveEvent);
    const results = await collectSourceMirrors(mirrorEvent);
    assertStagedMirrorComplete(event, results);
    const mirrorWarnings = stagedMirrorWarnings(results);
    let counts = { ...emptyCounts };
    const sourceSummaries: Record<string, unknown>[] = [];

    for (const result of results) {
      const stored = await storeMirrorResult(client, syncRunId, result);
      counts = addCounts(counts, stored);
      sourceSummaries.push({
        sourceKind: result.sourceKind,
        sourceId: result.sourceId,
        recordCount: result.records.length,
        snapshotKey: stored.snapshotKey,
        normalizedForum: stored.normalizedForum,
        metadata: result.metadata ?? {}
      });
    }

    const refreshId = event.refreshId ? requireRefreshId(event) : null;
    const forumUrlChunk =
      refreshId && (source === "github-issues-batch" || source === "google-sheet")
        ? await writeForumUrlChunk(
            refreshId,
            source === "github-issues-batch"
              ? `github-${Math.max(1, Math.floor(event.batchIndex ?? 1))}`
              : "google-sheet",
            results
          )
        : null;
    let forumUpdatesPlan: Awaited<ReturnType<typeof buildForumUrlManifest>> | null = null;

    if (refreshId && source === "forum-updates-plan") {
      const urls = results.flatMap((result) => {
        const rawUrls = result.rawPayload.urls;
        return Array.isArray(rawUrls)
          ? rawUrls.filter((value): value is string => typeof value === "string")
          : [];
      });
      const selectedUrls = [...new Set(urls)].sort((left, right) => left.localeCompare(right));
      const location = await putRefreshJson(refreshId, "forum-updates-manifest.json", { urls: selectedUrls });
      forumUpdatesPlan = {
        ...location,
        topicCount: selectedUrls.length,
        batchSize,
        batchIndexes: Array.from(
          { length: Math.ceil(selectedUrls.length / batchSize) },
          (_, index) => index
        )
      };
    }

    const reconciliation = event.reconcile
      ? await runGrantReconciliationForWorker(client, syncRunId, source)
      : null;

    if (reconciliation && reconciliationWasBusy(reconciliation)) {
      return await cancelSyncRunForBusyReconciliation(client, {
        syncRunId,
        source,
        counts,
        reconciliation,
        metadata: {
          parentSyncRunId: event.parentSyncRunId ?? null,
          refreshId,
          sources: sourceSummaries,
          forumUrlChunk,
          forumUpdatesPlan
        }
      });
    }

    const knowledgeIndex = await enqueueKnowledgeIndexRebuild(event, reconciliation !== null);
    const metadata = {
      phase: 1,
      dryRun: event.dryRun ?? false,
      parentSyncRunId: event.parentSyncRunId ?? null,
      refreshId,
      sources: sourceSummaries,
      forumUrlChunk,
      forumUpdatesPlan,
      reconciliation,
      knowledgeIndex,
      ...mirrorWarnings
    };

    await completeSyncRun(client, {
      syncRunId,
      counts,
      metadata
    });

    await client.query(
      `insert into audit_events (action, target_type, target_id, metadata)
       values ('sync_worker.completed', 'sync_run', $1, $2::jsonb)`,
      [syncRunId, JSON.stringify({ source, counts, ...metadata })]
    );

    const firstResultMetadata = results[0]?.metadata ?? {};

    return {
      ok: true,
      syncRunId,
      ...counts,
      sources: sourceSummaries,
      reconciliation,
      knowledgeIndex,
      forumUrlChunk,
      forumUpdatesPlan,
      ...mirrorWarnings,
      hasMore: firstResultMetadata.hasMore === true,
      nextPage:
        typeof firstResultMetadata.nextPage === "number" ? firstResultMetadata.nextPage : null
    };
  } catch (error) {
    await failSyncRun(client, syncRunId, source, error);

    if (syncRunId && (event.parentSyncRunId || event.refreshId)) {
      await client.query(
        `update sync_runs
            set metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb
          where id = $1`,
        [
          syncRunId,
          JSON.stringify({
            parentSyncRunId: event.parentSyncRunId ?? null,
            refreshId: event.refreshId ?? null
          })
        ]
      );
    }

    await client.query(
      `insert into audit_events (action, target_type, target_id, metadata)
       values ('sync_worker.failed', 'sync_run', $1, $2::jsonb)`,
      [syncRunId, JSON.stringify({ source, error: error instanceof Error ? error.message : String(error) })]
    );
    throw error;
  } finally {
    if (corpusRefreshLockAcquired) {
      try {
        const released = await releaseCorpusRefreshLock(client);

        if (!released) {
          console.error("Corpus refresh advisory lock was not held during explicit release", {
            lockName: CORPUS_REFRESH_LOCK_NAME,
            syncRunId
          });
        }
      } catch (error) {
        // Session-level advisory locks are also released when the database
        // connection closes below, so closing the client remains the final
        // safety net even if the explicit unlock query fails.
        console.error("Failed to explicitly release corpus refresh advisory lock", {
          error,
          lockName: CORPUS_REFRESH_LOCK_NAME,
          syncRunId
        });
      }
    }

    await client.end();
  }
}

export const syncWorkerTestHooks = {
  acquireCorpusRefreshLease,
  assertStagedMirrorComplete,
  corpusRefreshLeaseHours: CORPUS_REFRESH_LEASE_HOURS,
  corpusRefreshLeaseKey: CORPUS_REFRESH_LEASE_KEY,
  corpusRefreshLockName: CORPUS_REFRESH_LOCK_NAME,
  releaseCorpusRefreshLease,
  stagedMirrorWarnings,
  requiresCorpusRefreshLock,
  tryAcquireCorpusRefreshLock,
  releaseCorpusRefreshLock,
  recordBusySyncRun
};

if (process.argv[1]?.endsWith("sync-worker.ts")) {
  const args = process.argv.slice(2);
  const sourceArgIndex = args.indexOf("--source");
  const source =
    sourceArgIndex >= 0 ? args[sourceArgIndex + 1] : process.env.SYNC_SOURCE ?? "phase1-all";
  const dryRun = args.includes("--dry-run") || process.env.SYNC_DRY_RUN === "true";
  const reconcile = args.includes("--reconcile") || process.env.SYNC_RECONCILE === "true";

  handler({ source, dryRun, reconcile })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
