import assert from "node:assert/strict";
import test from "node:test";
import type { SourceMirrorResult } from "../../lib/source-mirroring/types";
import {
  createGoogleSheetPollHandler,
  googleSheetContentChecksum
} from "../../workers/google-sheet-poll-worker";

function sheetResult(options: { fetchedAt?: string; status?: string } = {}): SourceMirrorResult {
  const sheetId = "sheet-1";
  const gid = "123";
  const row = { Project: "Example grant", Status: options.status ?? "Under Review" };

  return {
    sourceKind: "google_sheet",
    sourceId: sheetId,
    sourceUrl: `https://docs.google.com/spreadsheets/d/${sheetId}`,
    rawPayload: {
      fetchedAt: options.fetchedAt ?? "2026-07-15T12:00:00.000Z",
      sheetId,
      tabs: [{ name: "grants", gid, headers: ["Project", "Status"], rows: [row] }]
    },
    records: [
      {
        sourceKind: "google_sheet_tab",
        sourceId: `${sheetId}:${gid}`,
        rawPayload: { sheetId, gid },
        metadata: { sheetId, gid }
      },
      {
        sourceKind: "google_sheet_row",
        sourceId: `${sheetId}:${gid}:row:2`,
        rawPayload: row,
        metadata: { sheetId, gid, rowNumber: 2 }
      }
    ],
    metadata: { fetchedAt: options.fetchedAt ?? "2026-07-15T12:00:00.000Z" }
  };
}

test("Google Sheet checksum ignores fetch timestamps but changes with cell content", () => {
  const first = googleSheetContentChecksum(sheetResult({
    fetchedAt: "2026-07-15T12:00:00.000Z"
  }));
  const later = googleSheetContentChecksum(sheetResult({
    fetchedAt: "2026-07-15T12:15:00.000Z"
  }));
  const changed = googleSheetContentChecksum(sheetResult({
    fetchedAt: "2026-07-15T12:15:00.000Z",
    status: "Approved"
  }));

  assert.equal(first, later);
  assert.notEqual(first, changed);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("Google Sheet checksum refuses an empty tab export before database work can start", () => {
  const result = sheetResult();
  result.rawPayload.tabs = [{ name: "grants", gid: "123", headers: [], rows: [] }];

  assert.throws(
    () => googleSheetContentChecksum(result),
    /empty or incomplete tab export/i
  );
});

test("poll check reports only content changes and never advances state", async () => {
  const result = sheetResult();
  const checksum = googleSheetContentChecksum(result);
  const handler = createGoogleSheetPollHandler({
    mirror: async () => result,
    readMarker: async () => ({
      schemaVersion: 1,
      checksum,
      committedAt: "2026-07-15T11:00:00.000Z"
    }),
    now: () => new Date("2026-07-15T12:15:00.000Z")
  });

  const checked = await handler({ action: "check" });

  assert.equal(checked.changed, false);
  assert.equal(checked.checksum, checksum);
  assert.equal(checked.recordCount, 2);
});

test("a missing success marker reports a change without mutating poll state", async () => {
  const result = sheetResult();
  const checksum = googleSheetContentChecksum(result);
  const handler = createGoogleSheetPollHandler({
    mirror: async () => result,
    readMarker: async () => null,
    now: () => new Date("2026-07-15T12:30:00.000Z")
  });

  const initial = await handler({ action: "check" });

  assert.equal(initial.changed, true);
  assert.equal(initial.previousChecksum, null);
  assert.equal(initial.checksum, checksum);
});
