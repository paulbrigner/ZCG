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

const { Client } = pg;
const s3 = new S3Client({});

type WorkerEvent = SourceMirrorEvent & {
  dryRun?: boolean;
  reconcile?: boolean;
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
): Promise<StoreCounts & { snapshotKey: string | null }> {
  const snapshot = await putSnapshot({
    syncRunId,
    source: result.sourceKind,
    sourceId: result.sourceId,
    payload: result.rawPayload
  });
  const rawSnapshotId = await recordSourceSnapshot(client, { syncRunId, result, snapshot });
  const counts = await upsertSourceRecords(client, result.records, rawSnapshotId);

  return { ...counts, snapshotKey: snapshot?.key ?? null };
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
