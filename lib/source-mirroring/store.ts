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

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }

  return value ?? null;
}

function observationFingerprint(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function sourceObservationMetadata(metadata: Record<string, unknown>) {
  const normalized = { ...metadata };

  // These fields describe importer/reconciliation execution rather than the
  // source object itself. Ignoring them prevents a fresh fetch timestamp or a
  // normalization marker from manufacturing a new source version.
  for (const key of [
    "fetchedAt",
    "forumNormalizationAttemptedChecksum",
    "forumNormalizationAttemptedAt",
    "forumNormalizationSyncRunId",
    "reconciliationGeneratedBy",
    "discoveredFrom",
    "relationshipRole"
  ]) {
    delete normalized[key];
  }

  return normalized;
}

type StoredSourceRecord = {
  id: string;
  source_id: string;
  source_url: string | null;
  source_updated_at: Date | string | null;
  checksum_sha256: string | null;
  title: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
};

function incomingObservation(
  record: SourceMirrorRecord,
  checksum: string,
  metadata: Record<string, unknown>
) {
  return {
    sourceId: record.sourceId,
    sourceUrl: record.sourceUrl ?? null,
    sourceUpdatedAt: record.sourceUpdatedAt ?? null,
    checksum,
    title: record.title ?? null,
    summary: record.summary ?? null,
    metadata: sourceObservationMetadata(metadata)
  };
}

function storedObservation(record: StoredSourceRecord) {
  return {
    sourceId: record.source_id,
    sourceUrl: record.source_url,
    sourceUpdatedAt: record.source_updated_at,
    checksum: record.checksum_sha256,
    title: record.title,
    summary: record.summary,
    metadata: sourceObservationMetadata(record.metadata)
  };
}

function metadataForUpdate(
  incoming: Record<string, unknown> | undefined,
  existing?: StoredSourceRecord,
  legacySourceId?: string
) {
  const metadata = { ...(incoming ?? {}) };
  const retainedLegacySourceId =
    legacySourceId ??
    (typeof existing?.metadata?.legacySourceId === "string"
      ? existing.metadata.legacySourceId
      : null);

  if (retainedLegacySourceId) {
    metadata.legacySourceId = retainedLegacySourceId;
  }

  return metadata;
}

async function findSourceRecord(
  client: pg.Client,
  record: SourceMirrorRecord
): Promise<{ stored: StoredSourceRecord; legacyClaim: boolean } | null> {
  const exact = await client.query<StoredSourceRecord>(
    `select id,
            source_id,
            source_url,
            source_updated_at,
            checksum_sha256,
            title,
            summary,
            metadata
       from source_records
      where source_kind = $1
        and source_id = $2`,
    [record.sourceKind, record.sourceId]
  );

  if (exact.rowCount) {
    return { stored: exact.rows[0], legacyClaim: false };
  }

  const metadata = record.metadata ?? {};
  const businessIdentifier =
    typeof metadata.businessIdentifier === "string"
      ? metadata.businessIdentifier
      : null;
  const sheetId = typeof metadata.sheetId === "string" ? metadata.sheetId : null;
  const gid = typeof metadata.gid === "string" ? metadata.gid : null;

  if (
    record.sourceKind !== "google_sheet_row" ||
    metadata.identityStrategy !== "grant_platform_link" ||
    !businessIdentifier ||
    !sheetId ||
    !gid
  ) {
    return null;
  }

  const legacy = await client.query<StoredSourceRecord>(
    `select id,
            source_id,
            source_url,
            source_updated_at,
            checksum_sha256,
            title,
            summary,
            metadata
       from source_records
      where source_kind = 'google_sheet_row'
        and source_id ~ ':row:[0-9]+$'
        and metadata->>'sheetId' = $1
        and metadata->>'gid' = $2
        and exists (
          select 1
            from jsonb_each_text(raw_payload) as source_field(field_name, field_value)
           where regexp_replace(
                   lower(btrim(source_field.field_name)),
                   '[^a-z0-9]+',
                   '',
                   'g'
                 ) = 'grantplatformlink'
             and regexp_replace(
                   btrim(source_field.field_value),
                   '/+$',
                   ''
                 ) = $3
        )
      order by source_id
      limit 2`,
    [sheetId, gid, businessIdentifier]
  );

  if ((legacy.rowCount ?? 0) > 1) {
    throw new Error(
      `Multiple legacy Google Sheet rows match business identifier ${businessIdentifier}; ` +
      "refusing to claim an ambiguous source record."
    );
  }

  return legacy.rowCount
    ? { stored: legacy.rows[0], legacyClaim: true }
    : null;
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
  rawSnapshotId: string | null,
  syncRunId: string | null = null
): Promise<StoreCounts> {
  const counts: StoreCounts = {
    recordsSeen: records.length,
    recordsCreated: 0,
    recordsUpdated: 0,
    recordsSkipped: 0
  };

  // The observation trigger uses this session-local provenance when a source
  // snapshot is unavailable. An empty value intentionally clears a prior run.
  await client.query(
    "select set_config('zcg.sync_run_id', $1, false)",
    [syncRunId ?? ""]
  );

  for (const record of records) {
    const checksum = checksumFor(record.rawPayload);
    const match = await findSourceRecord(client, record);
    const metadata = metadataForUpdate(
      record.metadata,
      match?.stored,
      match?.legacyClaim ? match.stored.source_id : undefined
    );

    if (!match) {
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
          JSON.stringify(metadata)
        ]
      );
      counts.recordsCreated += 1;
      continue;
    }

    const currentFingerprint = observationFingerprint(storedObservation(match.stored));
    const nextFingerprint = observationFingerprint(
      incomingObservation(record, checksum, metadata)
    );

    if (currentFingerprint === nextFingerprint) {
      counts.recordsSkipped += 1;
      continue;
    }

    await client.query(
      `update source_records
          set source_id = $2,
              source_url = $3,
              source_updated_at = $4,
              checksum_sha256 = $5,
              raw_snapshot_id = $6,
              title = $7,
              summary = $8,
              raw_payload = $9::jsonb,
              metadata = $10::jsonb,
              updated_at = now()
        where id = $1`,
      [
        match.stored.id,
        record.sourceId,
        record.sourceUrl ?? null,
        record.sourceUpdatedAt ?? null,
        checksum,
        rawSnapshotId,
        record.title ?? null,
        record.summary ?? null,
        JSON.stringify(record.rawPayload),
        JSON.stringify(metadata)
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
