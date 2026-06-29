import crypto from "node:crypto";
import type pg from "pg";
import type { SourceMirrorRecord, SourceMirrorResult } from "./types";

export type SnapshotReference = {
  bucket: string;
  key: string;
  checksum: string;
};

export type StoreCounts = {
  recordsSeen: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsSkipped: number;
};

function checksumFor(payload: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function recordSourceSnapshot(
  client: pg.Client,
  params: {
    syncRunId: string;
    result: SourceMirrorResult;
    snapshot: SnapshotReference | null;
  }
) {
  if (!params.snapshot) {
    return null;
  }

  const inserted = await client.query<{ id: string }>(
    `insert into source_snapshots (
       sync_run_id,
       source_kind,
       source_id,
       source_url,
       s3_bucket,
       s3_key,
       checksum_sha256
     )
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (source_kind, source_id, checksum_sha256)
     do update set captured_at = source_snapshots.captured_at
     returning id`,
    [
      params.syncRunId,
      params.result.sourceKind,
      params.result.sourceId,
      params.result.sourceUrl ?? null,
      params.snapshot.bucket,
      params.snapshot.key,
      params.snapshot.checksum
    ]
  );

  return inserted.rows[0]?.id ?? null;
}

export async function upsertSourceRecords(
  client: pg.Client,
  records: SourceMirrorRecord[],
  rawSnapshotId: string | null
): Promise<StoreCounts> {
  const counts: StoreCounts = {
    recordsSeen: records.length,
    recordsCreated: 0,
    recordsUpdated: 0,
    recordsSkipped: 0
  };

  for (const record of records) {
    const checksum = checksumFor(record.rawPayload);
    const existing = await client.query<{ checksum_sha256: string | null }>(
      `select checksum_sha256
         from source_records
        where source_kind = $1
          and source_id = $2`,
      [record.sourceKind, record.sourceId]
    );

    if (!existing.rowCount) {
      await client.query(
        `insert into source_records (
           source_kind,
           source_id,
           source_url,
           source_updated_at,
           checksum_sha256,
           raw_snapshot_id,
           title,
           summary,
           raw_payload,
           metadata
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
        [
          record.sourceKind,
          record.sourceId,
          record.sourceUrl ?? null,
          record.sourceUpdatedAt ?? null,
          checksum,
          rawSnapshotId,
          record.title ?? null,
          record.summary ?? null,
          JSON.stringify(record.rawPayload),
          JSON.stringify(record.metadata ?? {})
        ]
      );
      counts.recordsCreated += 1;
      continue;
    }

    if (existing.rows[0]?.checksum_sha256 === checksum) {
      counts.recordsSkipped += 1;
      continue;
    }

    await client.query(
      `update source_records
          set source_url = $3,
              source_updated_at = $4,
              checksum_sha256 = $5,
              raw_snapshot_id = coalesce($6, raw_snapshot_id),
              title = $7,
              summary = $8,
              raw_payload = $9::jsonb,
              metadata = $10::jsonb,
              updated_at = now()
        where source_kind = $1
          and source_id = $2`,
      [
        record.sourceKind,
        record.sourceId,
        record.sourceUrl ?? null,
        record.sourceUpdatedAt ?? null,
        checksum,
        rawSnapshotId,
        record.title ?? null,
        record.summary ?? null,
        JSON.stringify(record.rawPayload),
        JSON.stringify(record.metadata ?? {})
      ]
    );
    counts.recordsUpdated += 1;
  }

  return counts;
}

export function addCounts(left: StoreCounts, right: StoreCounts): StoreCounts {
  return {
    recordsSeen: left.recordsSeen + right.recordsSeen,
    recordsCreated: left.recordsCreated + right.recordsCreated,
    recordsUpdated: left.recordsUpdated + right.recordsUpdated,
    recordsSkipped: left.recordsSkipped + right.recordsSkipped
  };
}

export const emptyCounts: StoreCounts = {
  recordsSeen: 0,
  recordsCreated: 0,
  recordsUpdated: 0,
  recordsSkipped: 0
};
