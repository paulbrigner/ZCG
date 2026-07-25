import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type pg from "pg";
import { upsertSourceRecords } from "../../lib/source-mirroring/store";
import type { SourceMirrorRecord } from "../../lib/source-mirroring/types";

type QueryCall = { text: string; values: unknown[] };

function sourceRecord(rowNumber: number, status = "Submitted"): SourceMirrorRecord {
  return {
    sourceKind: "google_sheet_row",
    sourceId: "sheet-one:grants:grant-platform:stable-id",
    sourceUrl: "https://docs.google.com/spreadsheets/d/sheet-one/edit?gid=grants",
    sourceUpdatedAt: null,
    title: "Grant Alpha",
    summary: `Proposal Title: Grant Alpha | Grant Status: ${status}`,
    rawPayload: {
      "Proposal Title": "Grant Alpha",
      "Grant Platform Link": "https://example.com/grants/alpha",
      "Grant Status": status
    },
    metadata: {
      sheetId: "sheet-one",
      gid: "grants",
      tabName: "all_grants_tracking",
      rowNumber,
      rowLocationSourceId: `sheet-one:grants:row:${rowNumber}`,
      identityStrategy: "grant_platform_link",
      businessIdentifierField: "Grant Platform Link",
      businessIdentifier: "https://example.com/grants/alpha",
      businessIdentifierRaw: "https://example.com/grants/alpha"
    }
  };
}

function storedRecord(record: SourceMirrorRecord, rowNumber: number) {
  return {
    id: "source-record-uuid",
    source_id: record.sourceId,
    source_url: record.sourceUrl ?? null,
    source_updated_at: null,
    checksum_sha256: createHash("sha256")
      .update(JSON.stringify(record.rawPayload))
      .digest("hex"),
    title: record.title ?? null,
    summary: record.summary ?? null,
    raw_payload: record.rawPayload,
    metadata: {
      ...record.metadata,
      rowNumber,
      rowLocationSourceId: `sheet-one:grants:row:${rowNumber}`
    }
  };
}

test("new stable Sheet records are inserted with sync provenance configured", async () => {
  const calls: QueryCall[] = [];
  const record = sourceRecord(2);
  const client = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return { rows: [], rowCount: 0 };
    }
  } as unknown as pg.Client;

  const counts = await upsertSourceRecords(client, [record], "snapshot-id", "sync-run-id");

  assert.deepEqual(counts, {
    recordsSeen: 1,
    recordsCreated: 1,
    recordsUpdated: 0,
    recordsSkipped: 0
  });
  assert.match(calls[0].text, /set_config\('zcg\.sync_run_id'/);
  assert.deepEqual(calls[0].values, ["sync-run-id"]);
  assert.equal(calls.some((call) => call.text.includes("insert into source_records")), true);
});

test("an unchanged row move updates locator metadata without changing the stable source identity", async () => {
  const calls: QueryCall[] = [];
  const incoming = sourceRecord(3);
  const existing = storedRecord(incoming, 2);
  const client = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (text.includes("where source_kind = $1") && text.includes("source_id = $2")) {
        return { rows: [existing], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  } as unknown as pg.Client;

  const counts = await upsertSourceRecords(client, [incoming], "snapshot-id", "sync-run-id");
  const update = calls.find((call) => call.text.includes("update source_records"));

  assert.equal(counts.recordsUpdated, 1);
  assert.equal(counts.recordsSkipped, 0);
  assert.equal(update?.values[0], "source-record-uuid");
  assert.equal(update?.values[1], incoming.sourceId);
  assert.equal(JSON.parse(String(update?.values[9])).rowNumber, 3);
});

test("a byte-equivalent observation is skipped", async () => {
  const incoming = sourceRecord(2);
  const existing = storedRecord(incoming, 2);
  const calls: QueryCall[] = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (text.includes("where source_kind = $1") && text.includes("source_id = $2")) {
        return { rows: [existing], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  } as unknown as pg.Client;

  const counts = await upsertSourceRecords(client, [incoming], null, "sync-run-id");

  assert.equal(counts.recordsSkipped, 1);
  assert.equal(calls.some((call) => call.text.includes("update source_records")), false);
  assert.equal(calls.some((call) => call.text.includes("insert into source_records")), false);
});

test("non-Sheet metadata changes are stored even when the raw payload checksum is unchanged", async () => {
  const incoming: SourceMirrorRecord = {
    sourceKind: "github_issue",
    sourceId: "owner/repo#1",
    sourceUrl: "https://github.com/owner/repo/issues/1",
    title: "Issue title",
    summary: "Updated summary",
    rawPayload: { id: 1 },
    metadata: { labels: ["approved"] }
  };
  const existing = {
    ...storedRecord(incoming, 2),
    summary: "Old summary",
    metadata: { labels: ["pending"] }
  };
  const calls: QueryCall[] = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (text.includes("where source_kind = $1") && text.includes("source_id = $2")) {
        return { rows: [existing], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  } as unknown as pg.Client;

  const counts = await upsertSourceRecords(client, [incoming], null, "sync-run-id");
  const update = calls.find((call) => call.text.includes("update source_records"));

  assert.equal(counts.recordsUpdated, 1);
  assert.equal(update?.values[5], null);
  assert.match(update?.text ?? "", /raw_snapshot_id = \$6/);
});

test("volatile fetch and normalization metadata does not manufacture a source version", async () => {
  const incoming: SourceMirrorRecord = {
    sourceKind: "forum_link",
    sourceId: "https://forum.example/t/grant/1",
    sourceUrl: "https://forum.example/t/grant/1",
    sourceUpdatedAt: "2026-07-01T12:00:00.000Z",
    title: "Grant discussion",
    summary: "Unchanged discussion",
    rawPayload: { topic: { id: 1 } },
    metadata: {
      source: "forum_mirror",
      mirrorKind: "forum_topic",
      fetchedAt: "2026-07-25T12:00:00.000Z"
    }
  };
  const existing = {
    ...storedRecord(incoming, 2),
    source_updated_at: incoming.sourceUpdatedAt,
    metadata: {
      ...incoming.metadata,
      fetchedAt: "2026-07-24T12:00:00.000Z",
      forumNormalizationAttemptedChecksum: "unchanged",
      forumNormalizationAttemptedAt: "2026-07-24T12:01:00.000Z",
      forumNormalizationSyncRunId: "prior-run",
      reconciliationGeneratedBy: "grant_reconciliation_v1"
    }
  };
  const calls: QueryCall[] = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (text.includes("where source_kind = $1") && text.includes("source_id = $2")) {
        return { rows: [existing], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  } as unknown as pg.Client;

  const counts = await upsertSourceRecords(client, [incoming], null, "sync-run-id");

  assert.equal(counts.recordsSkipped, 1);
  assert.equal(calls.some((call) => call.text.includes("update source_records")), false);
});

test("the transition path rekeys one matching legacy row in place and preserves its UUID", async () => {
  const calls: QueryCall[] = [];
  const incoming = sourceRecord(8);
  const legacy = {
    ...storedRecord(incoming, 8),
    source_id: "sheet-one:grants:row:8",
    metadata: {
      sheetId: "sheet-one",
      gid: "grants",
      tabName: "all_grants_tracking",
      rowNumber: 8
    }
  };
  const client = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (text.includes("where source_kind = $1") && text.includes("source_id = $2")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("source_id ~ ':row:[0-9]+$'")) {
        return { rows: [legacy], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  } as unknown as pg.Client;

  const counts = await upsertSourceRecords(client, [incoming], "snapshot-id", "sync-run-id");
  const update = calls.find((call) => call.text.includes("update source_records"));
  const metadata = JSON.parse(String(update?.values[9]));

  assert.equal(counts.recordsCreated, 0);
  assert.equal(counts.recordsUpdated, 1);
  assert.equal(update?.values[0], "source-record-uuid");
  assert.equal(update?.values[1], incoming.sourceId);
  assert.equal(metadata.legacySourceId, "sheet-one:grants:row:8");
});

test("the transition path refuses multiple legacy rows for one business identifier", async () => {
  const incoming = sourceRecord(8);
  const legacy = {
    ...storedRecord(incoming, 8),
    source_id: "sheet-one:grants:row:8"
  };
  const client = {
    async query(text: string) {
      if (text.includes("where source_kind = $1") && text.includes("source_id = $2")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("source_id ~ ':row:[0-9]+$'")) {
        return {
          rows: [legacy, { ...legacy, id: "other-uuid", source_id: "sheet-one:grants:row:9" }],
          rowCount: 2
        };
      }
      return { rows: [], rowCount: 0 };
    }
  } as unknown as pg.Client;

  await assert.rejects(
    upsertSourceRecords(client, [incoming], null, "sync-run-id"),
    /Multiple legacy Google Sheet rows match business identifier/
  );
});

test("the transition claim normalizes the legacy Grant Platform Link header", async () => {
  const incoming = sourceRecord(8);
  const legacy = {
    ...storedRecord(incoming, 8),
    source_id: "sheet-one:grants:row:8"
  };
  const calls: QueryCall[] = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (text.includes("where source_kind = $1") && text.includes("source_id = $2")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("jsonb_each_text(raw_payload)")) {
        return { rows: [legacy], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  } as unknown as pg.Client;

  await upsertSourceRecords(client, [incoming], null, "sync-run-id");

  const claim = calls.find((call) => call.text.includes("jsonb_each_text(raw_payload)"));
  assert.match(claim?.text ?? "", /grantplatformlink/);
  assert.equal(claim?.values[2], "https://example.com/grants/alpha");
});
