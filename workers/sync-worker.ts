import crypto from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";
import { workerDatabaseUrl } from "../lib/worker-db-url";

const { Client } = pg;
const s3 = new S3Client({});

type WorkerEvent = {
  source?: string;
  dryRun?: boolean;
};

async function putSnapshot(params: {
  syncRunId: string;
  source: string;
  payload: Record<string, unknown>;
}) {
  const bucket = process.env.SNAPSHOT_BUCKET_NAME;

  if (!bucket) {
    return null;
  }

  const body = JSON.stringify(params.payload, null, 2);
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const key = `phase0/${params.source}/${params.syncRunId}.json`;

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

export async function handler(event: WorkerEvent = {}) {
  const source = event.source ?? "phase0";
  const client = new Client({
    connectionString: await workerDatabaseUrl(),
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined
  });

  await client.connect();

  try {
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

    await client.query(
      `update sync_runs
          set status = 'completed',
              records_seen = 0,
              completed_at = now()
        where id = $1`,
      [syncRunId]
    );

    await client.query(
      `insert into audit_events (action, target_type, target_id, metadata)
       values ('sync_worker.completed', 'sync_run', $1, $2::jsonb)`,
      [syncRunId, JSON.stringify({ source, snapshotKey: snapshot?.key ?? null })]
    );

    return { ok: true, syncRunId, snapshotKey: snapshot?.key ?? null };
  } catch (error) {
    await client.query(
      `insert into sync_runs (source, status, error_summary, started_at, completed_at)
       values ($1, 'failed', $2, now(), now())`,
      [source, error instanceof Error ? error.message : String(error)]
    );
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("sync-worker.ts")) {
  handler({ source: process.env.SYNC_SOURCE ?? "phase0-local", dryRun: true })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
