import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  grantPlatformSourceId,
  mirrorGoogleSheetTabs,
  normalizeGrantPlatformIdentifier
} from "../../lib/source-mirroring/google-sheet";

async function mirrorCsv(csv: string, tabName = "all_grants_tracking") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(csv, {
    status: 200,
    headers: { "content-type": "text/csv" }
  });

  try {
    return await mirrorGoogleSheetTabs({
      sheetId: "sheet-one",
      tabs: [{ name: tabName, gid: "grants" }]
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function sheetRows(result: Awaited<ReturnType<typeof mirrorCsv>>) {
  return result.records.filter((record) => record.sourceKind === "google_sheet_row");
}

test("All Grants identities stay attached to Grant Platform Link values across reorder and edits", async () => {
  const first = await mirrorCsv([
    "Proposal Title,Grant Platform Link,Grant Status",
    "Grant Alpha,https://example.com/grants/alpha/,Submitted",
    "Grant Beta,https://example.com/grants/beta,Approved"
  ].join("\n"));
  const reordered = await mirrorCsv([
    "Proposal Title,Grant Platform Link,Grant Status",
    "Grant Beta,https://example.com/grants/beta,Completed",
    "Grant Alpha,https://example.com/grants/alpha,Submitted"
  ].join("\n"));

  const firstByTitle = new Map(
    sheetRows(first).map((record) => [record.rawPayload["Proposal Title"], record])
  );
  const reorderedByTitle = new Map(
    sheetRows(reordered).map((record) => [record.rawPayload["Proposal Title"], record])
  );

  assert.equal(
    firstByTitle.get("Grant Alpha")?.sourceId,
    grantPlatformSourceId("sheet-one", "grants", "https://example.com/grants/alpha")
  );
  assert.equal(
    firstByTitle.get("Grant Alpha")?.sourceId,
    reorderedByTitle.get("Grant Alpha")?.sourceId
  );
  assert.equal(
    firstByTitle.get("Grant Beta")?.sourceId,
    reorderedByTitle.get("Grant Beta")?.sourceId
  );
  assert.notEqual(
    firstByTitle.get("Grant Alpha")?.sourceId,
    firstByTitle.get("Grant Beta")?.sourceId
  );
  assert.equal(firstByTitle.get("Grant Alpha")?.metadata?.rowNumber, 2);
  assert.equal(reorderedByTitle.get("Grant Alpha")?.metadata?.rowNumber, 3);
  assert.equal(reorderedByTitle.get("Grant Beta")?.rawPayload["Grant Status"], "Completed");
});

test("Grant Platform Link is an opaque, normalized identifier, including the legacy NA value", async () => {
  const result = await mirrorCsv([
    "Proposal Title,Grant Platform Link",
    "Legacy grant,NA"
  ].join("\n"));
  const record = sheetRows(result)[0];

  assert.equal(normalizeGrantPlatformIdentifier("  https://example.com/grant///  "), "https://example.com/grant");
  assert.equal(record.sourceId, grantPlatformSourceId("sheet-one", "grants", "NA"));
  assert.equal(record.metadata?.businessIdentifier, "NA");
  assert.equal(record.metadata?.identityStrategy, "grant_platform_link");
});

test("duplicate normalized Grant Platform Link values reject the mirror", async () => {
  await assert.rejects(
    mirrorCsv([
      "Proposal Title,Grant Platform Link",
      "Grant Alpha,https://example.com/grants/alpha/",
      "Grant Alpha duplicate,https://example.com/grants/alpha"
    ].join("\n")),
    /duplicate Grant Platform Link.*rows 2 and 3/i
  );
});

test("a tab declaring Grant Platform Link cannot silently fall back to row identity", async () => {
  await assert.rejects(
    mirrorCsv([
      "Proposal Title,Grant Platform Link",
      "Grant Alpha,"
    ].join("\n")),
    /missing Grant Platform Link.*mutable row-number identity/i
  );
});

test("milestone rows remain location-addressed while retaining their current locator", async () => {
  const result = await mirrorCsv([
    "Project,Grantee,Milestone",
    "Grant Alpha,Alice,1"
  ].join("\n"), "milestone_details");
  const record = sheetRows(result)[0];

  assert.equal(record.sourceId, "sheet-one:grants:row:2");
  assert.equal(record.metadata?.identityStrategy, "sheet_row_location");
  assert.equal(record.metadata?.rowLocationSourceId, "sheet-one:grants:row:2");
});

test("a non-All-Grants tab does not infer business identity from an incidental Grant Platform Link column", async () => {
  const result = await mirrorCsv([
    "Project,Grant Platform Link,Milestone",
    "Grant Alpha,https://example.com/grants/alpha,1",
    "Grant Alpha,https://example.com/grants/alpha,2"
  ].join("\n"), "milestone_details");
  const records = sheetRows(result);

  assert.deepEqual(
    records.map((record) => record.sourceId),
    ["sheet-one:grants:row:2", "sheet-one:grants:row:3"]
  );
  assert.equal(records[0].metadata?.identityStrategy, "sheet_row_location");
});

test("an explicitly configured dataset can opt into Grant Platform Link identity", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    "Proposal Title,Grant Platform Link",
    "Grant Alpha,https://example.com/grants/alpha"
  ].join("\n"), { status: 200 });

  try {
    const result = await mirrorGoogleSheetTabs({
      sheetId: "sheet-one",
      tabs: [{
        name: "renamed_registry",
        gid: "grants",
        rowIdentity: "grant_platform_link"
      }]
    });

    assert.match(sheetRows(result)[0].sourceId, /:grant-platform:[a-f0-9]{64}$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Grant Platform Link header matching ignores normal punctuation, case, and whitespace", async () => {
  const result = await mirrorCsv([
    "Proposal Title, GRANT PLATFORM LINK ",
    "Grant Alpha,https://example.com/grants/alpha"
  ].join("\n"));
  const record = sheetRows(result)[0];

  assert.match(record.sourceId, /:grant-platform:[a-f0-9]{64}$/);
  assert.equal(record.metadata?.businessIdentifier, "https://example.com/grants/alpha");
});

test("portable All Grants decisions use the same stable-ID normalizer as the importer", async () => {
  const portable = JSON.parse(
    await fs.readFile("data/reconciliation-decisions.json", "utf8")
  ) as {
    decisions: Array<{
      source_kind: string | null;
      source_id: string | null;
      evidence?: Record<string, unknown>;
    }>;
  };
  const migrated = portable.decisions.filter(
    (decision) =>
      decision.source_kind === "google_sheet_row" &&
      decision.evidence?.stableIdentityMigration === "grant_platform_link_v1"
  );

  assert.equal(migrated.length, 3);
  for (const decision of migrated) {
    const legacySourceId = String(decision.evidence?.legacySourceId ?? "");
    const businessIdentifier = String(decision.evidence?.businessIdentifier ?? "");
    const match = legacySourceId.match(/^(.*):([^:]+):row:\d+$/);

    assert.ok(match, `invalid legacy Sheet source ID: ${legacySourceId}`);
    assert.equal(
      decision.source_id,
      grantPlatformSourceId(match[1], match[2], businessIdentifier)
    );
  }
});
