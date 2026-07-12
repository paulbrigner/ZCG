import crypto from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";
import { workerDatabaseUrl } from "../lib/worker-db-url";
import { collectSourceMirrors, type SourceMirrorEvent, type SourceMirrorResult } from "../lib/source-mirroring";
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

type WorkerEvent = SourceMirrorEvent & {
  dryRun?: boolean;
  reconcile?: boolean;
  backfillLimit?: number;
};

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

  const { runGrantReconciliation } = await import("../lib/reconciliation/grants");
  const result = await runGrantReconciliation();

  await client.query(
    `insert into audit_events (action, target_type, target_id, metadata)
     values ('sync_worker.reconciliation.completed', 'sync_run', $1, $2::jsonb)`,
    [syncRunId, JSON.stringify({ source, result })]
  );

  return result;
}

export async function handler(event: WorkerEvent = {}) {
  const source = event.source ?? "phase1-all";
  const client = new Client({
    connectionString: await workerDatabaseUrl(),
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined
  });

  await client.connect();
  let syncRunId: string | null = null;

  try {
    syncRunId = await createSyncRun(client, source);

    if (source.startsWith("phase0")) {
      return await runPhase0Skeleton(client, syncRunId, event);
    }

    if (source === "reconcile-grants") {
      const reconciliation = await runGrantReconciliationForWorker(client, syncRunId, source);

      await completeSyncRun(client, {
        syncRunId,
        counts: { ...emptyCounts },
        metadata: {
          phase: "reconciliation",
          dryRun: event.dryRun ?? false,
          reconciliation
        }
      });

      return { ok: true, syncRunId, reconciliation };
    }

    if (source === "forum-normalize-backfill") {
      return await runForumNormalizationBackfill(client, syncRunId, event);
    }

    if (source === "forum-complete-backfill") {
      return await runForumCompletionBackfill(client, syncRunId, event);
    }

    const mirrorEvent = await sourceEventWithResumeSkips(client, event);
    const results = await collectSourceMirrors(mirrorEvent);
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

    await completeSyncRun(client, {
      syncRunId,
      counts,
      metadata: {
        phase: 1,
        dryRun: event.dryRun ?? false,
        sources: sourceSummaries
      }
    });

    await client.query(
      `insert into audit_events (action, target_type, target_id, metadata)
       values ('sync_worker.completed', 'sync_run', $1, $2::jsonb)`,
      [syncRunId, JSON.stringify({ source, phase: 1, counts, sources: sourceSummaries })]
    );

    const reconciliation = event.reconcile
      ? await runGrantReconciliationForWorker(client, syncRunId, source)
      : null;

    return { ok: true, syncRunId, ...counts, sources: sourceSummaries, reconciliation };
  } catch (error) {
    await failSyncRun(client, syncRunId, source, error);
    await client.query(
      `insert into audit_events (action, target_type, target_id, metadata)
       values ('sync_worker.failed', 'sync_run', $1, $2::jsonb)`,
      [syncRunId, JSON.stringify({ source, error: error instanceof Error ? error.message : String(error) })]
    );
    throw error;
  } finally {
    await client.end();
  }
}

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
