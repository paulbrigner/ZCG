import assert from "node:assert/strict";
import test from "node:test";
import type { SourceMirrorResult } from "../../lib/source-mirroring/types";
import { syncWorkerTestHooks } from "../../workers/sync-worker";

type LockClient = Parameters<typeof syncWorkerTestHooks.tryAcquireCorpusRefreshLock>[0];

function completeSheetResult(): SourceMirrorResult {
  return {
    sourceKind: "google_sheet",
    sourceId: "sheet-1",
    rawPayload: {
      sheetId: "sheet-1",
      tabs: [{
        name: "grants",
        gid: "123",
        headers: ["Project", "Status"],
        rows: [{ Project: "Example", Status: "Under Review" }]
      }]
    },
    records: [
      {
        sourceKind: "google_sheet_tab",
        sourceId: "sheet-1:123",
        rawPayload: {},
        metadata: { sheetId: "sheet-1", gid: "123" }
      },
      {
        sourceKind: "google_sheet_row",
        sourceId: "sheet-1:123:row:2",
        rawPayload: { Project: "Example", Status: "Under Review" },
        metadata: { sheetId: "sheet-1", gid: "123", rowNumber: 2 }
      }
    ]
  };
}

test("serializes only full combined refreshes and standalone reconciliation", () => {
  assert.equal(
    syncWorkerTestHooks.requiresCorpusRefreshLock("phase1-all", { reconcile: true }),
    true
  );
  assert.equal(
    syncWorkerTestHooks.requiresCorpusRefreshLock("reconcile-grants", {}),
    true
  );
  assert.equal(
    syncWorkerTestHooks.requiresCorpusRefreshLock("phase1-all", { reconcile: false }),
    false
  );
  assert.equal(
    syncWorkerTestHooks.requiresCorpusRefreshLock("github", { reconcile: false }),
    false
  );
  assert.equal(
    syncWorkerTestHooks.requiresCorpusRefreshLock("google-sheets", {}),
    false
  );
});

test("acquires and releases the same session-level PostgreSQL advisory lock", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });

      if (text.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }

      if (text.includes("pg_advisory_unlock")) {
        return { rows: [{ released: true }], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${text}`);
    }
  } as unknown as LockClient;

  assert.equal(await syncWorkerTestHooks.tryAcquireCorpusRefreshLock(client), true);
  assert.equal(await syncWorkerTestHooks.releaseCorpusRefreshLock(client), true);
  assert.equal(queries.length, 2);
  assert.match(queries[0].text, /pg_try_advisory_lock\(hashtextextended/);
  assert.match(queries[1].text, /pg_advisory_unlock\(hashtextextended/);
  assert.deepEqual(queries[0].values, [syncWorkerTestHooks.corpusRefreshLockName]);
  assert.deepEqual(queries[1].values, [syncWorkerTestHooks.corpusRefreshLockName]);
});

test("records a durable cancelled run and clear busy result when single-flight is occupied", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });

      if (text.includes("insert into sync_runs")) {
        return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }], rowCount: 1 };
      }

      if (text.includes("insert into audit_events")) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${text}`);
    }
  } as unknown as LockClient;

  const result = await syncWorkerTestHooks.recordBusySyncRun(client, "phase1-all", {
    reconcile: true,
    requestedAt: "2026-07-14T07:00:00.000Z",
    requestedByPrincipalId: "00000000-0000-4000-8000-000000000002"
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.busy, true);
  assert.match(result.message, /another full corpus refresh or grant reconciliation/i);
  assert.match(queries[0].text, /'cancelled'/);
  assert.match(queries[0].text, /error_summary/);
  assert.deepEqual(JSON.parse(String(queries[0].values[2])), {
    phase: "single_flight",
    busy: true,
    skipped: true,
    lockName: syncWorkerTestHooks.corpusRefreshLockName,
    requestedAt: "2026-07-14T07:00:00.000Z",
    requestedByPrincipalId: "00000000-0000-4000-8000-000000000002"
  });
  assert.match(queries[1].text, /sync_worker\.skipped_busy/);
});

test("claims one durable full-refresh lease and creates its parent telemetry run atomically", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });

      if (text === "begin" || text === "commit") {
        return { rows: [], rowCount: null };
      }

      if (text.includes("from idempotency_keys") && text.includes("for update")) {
        return { rows: [], rowCount: 0 };
      }

      if (text.includes("insert into idempotency_keys")) {
        return { rows: [{ result: { owner: "refresh-1" } }], rowCount: 1 };
      }

      if (text.includes("insert into sync_runs")) {
        return { rows: [{ id: "00000000-0000-4000-8000-000000000010" }], rowCount: 1 };
      }

      if (text.includes("update idempotency_keys")) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${text}`);
    }
  } as unknown as LockClient;

  const result = await syncWorkerTestHooks.acquireCorpusRefreshLease(client, {
    source: "corpus-refresh-acquire",
    refreshId: "refresh-1",
    trigger: "schedule",
    requestedAt: "2026-07-14T07:00:00.000Z"
  });

  assert.deepEqual(result, {
    acquired: true,
    refreshId: "refresh-1",
    parentSyncRunId: "00000000-0000-4000-8000-000000000010"
  });
  assert.equal(queries[0].text, "begin");
  assert.match(queries[1].text, /for update/);
  assert.match(queries[2].text, /on conflict \(key\) do update/);
  assert.match(queries[2].text, /when idempotency_keys\.result->>'owner'/);
  assert.match(queries[2].text, /else excluded\.result/);
  assert.deepEqual(queries[2].values.slice(0, 3), [
    syncWorkerTestHooks.corpusRefreshLeaseKey,
    "corpus-refresh",
    syncWorkerTestHooks.corpusRefreshLeaseMinutes
  ]);
  assert.equal(queries[3].values[4], "phase1-all");
  assert.equal(queries[3].values[5], "corpus_refresh_pipeline");
  assert.match(queries[4].text, /parentSyncRunId/);
  assert.equal(queries[5].text, "commit");
});

test("records a Sheet refresh as a distinct owner while using the shared corpus lease", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });

      if (text === "begin" || text === "commit") {
        return { rows: [], rowCount: null };
      }

      if (text.includes("from idempotency_keys") && text.includes("for update")) {
        return { rows: [], rowCount: 0 };
      }

      if (text.includes("insert into idempotency_keys")) {
        return { rows: [{ result: { owner: "sheet-refresh-1" } }], rowCount: 1 };
      }

      if (text.includes("insert into sync_runs")) {
        return { rows: [{ id: "00000000-0000-4000-8000-000000000011" }], rowCount: 1 };
      }

      if (text.includes("update idempotency_keys")) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${text}`);
    }
  } as unknown as LockClient;

  const result = await syncWorkerTestHooks.acquireCorpusRefreshLease(client, {
    source: "corpus-refresh-acquire",
    refreshId: "sheet-refresh-1",
    refreshKind: "google-sheet",
    trigger: "schedule"
  });

  assert.equal(result.acquired, true);
  assert.equal(queries[2].values[7], "sheet_refresh");
  assert.equal(queries[2].values[8], "google-sheet");
  assert.equal(queries[2].values[2], syncWorkerTestHooks.googleSheetRefreshLeaseMinutes);
  assert.equal(queries[3].values[4], "google-sheet-refresh");
  assert.equal(queries[3].values[5], "google_sheet_refresh_pipeline");
});

test("fails an abandoned parent run before an expired refresh lease is reassigned", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });

      if (text === "begin" || text === "commit") {
        return { rows: [], rowCount: null };
      }

      if (text.includes("from idempotency_keys") && text.includes("for update")) {
        return {
          rows: [
            {
              result: {
                owner: "expired-refresh",
                parentSyncRunId: "00000000-0000-4000-8000-000000000020"
              },
              reclaimable: true
            }
          ],
          rowCount: 1
        };
      }

      if (text.includes("insert into idempotency_keys")) {
        return { rows: [{ result: { owner: "replacement-refresh" } }], rowCount: 1 };
      }

      if (text.includes("update sync_runs")) {
        return { rows: [], rowCount: 1 };
      }

      if (text.includes("insert into sync_runs")) {
        return { rows: [{ id: "00000000-0000-4000-8000-000000000021" }], rowCount: 1 };
      }

      if (text.includes("update idempotency_keys")) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${text}`);
    }
  } as unknown as LockClient;

  const result = await syncWorkerTestHooks.acquireCorpusRefreshLease(client, {
    source: "corpus-refresh-acquire",
    refreshId: "replacement-refresh",
    trigger: "schedule"
  });

  assert.equal(result.parentSyncRunId, "00000000-0000-4000-8000-000000000021");
  const staleRunUpdate = queries.find((query) => query.text.includes("update sync_runs"));
  assert.ok(staleRunUpdate);
  assert.match(staleRunUpdate.text, /status = 'failed'/);
  assert.match(staleRunUpdate.text, /staleLeaseRecoveredByRefreshId/);
  assert.deepEqual(staleRunUpdate.values, [
    "00000000-0000-4000-8000-000000000020",
    "replacement-refresh",
    "expired-refresh"
  ]);
});

test("identifies a targeted event owner when the durable refresh lease is occupied", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });

      if (text === "begin" || text === "rollback") {
        return { rows: [], rowCount: null };
      }

      if (text.includes("from idempotency_keys") && text.includes("for update")) {
        return {
          rows: [{ result: { owner: "active-event", ownerKind: "corpus_event" }, reclaimable: false }],
          rowCount: 1
        };
      }

      if (text.includes("insert into idempotency_keys")) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${text}`);
    }
  } as unknown as LockClient;

  const result = await syncWorkerTestHooks.acquireCorpusRefreshLease(client, {
    source: "corpus-refresh-acquire",
    refreshId: "refresh-2",
    trigger: "admin"
  });

  assert.equal(result.acquired, false);
  assert.equal(result.parentSyncRunId, null);
  assert.equal(result.busyOwnerKind, "corpus_event");
  assert.match(result.message ?? "", /targeted corpus event/i);
  assert.equal(queries.length, 4);
  assert.equal(queries[0].text, "begin");
  assert.match(queries[1].text, /for update/);
  assert.match(queries[2].text, /insert into idempotency_keys/);
  assert.equal(queries[3].text, "rollback");
});

test("treats unavailable Forum topics as coverage warnings in a staged refresh", () => {
  const result = {
    sourceKind: "forum_topics",
    sourceId: "forum.zcashcommunity.com",
    rawPayload: {},
    records: [],
    metadata: {
      topicCountUnavailable: 1,
      topicCountPartial: 2,
      topicErrorCount: 0,
      categoryFailureCount: 0,
      rateLimitedAt: null
    }
  };

  assert.doesNotThrow(() =>
    syncWorkerTestHooks.assertStagedMirrorComplete(
      { source: "forum-topics-batch", refreshId: "refresh-forum-warning" },
      [result]
    )
  );
  assert.deepEqual(syncWorkerTestHooks.stagedMirrorWarnings([result]), {
    warningCount: 3,
    warnings: [
      "forum_topics: 1 topic(s) were unavailable or not public.",
      "forum_topics: 2 topic(s) had partial post coverage."
    ]
  });
});

test("blocks staged refresh batches on Forum rate limits and fetch errors", () => {
  for (const metadata of [
    { rateLimitedAt: "https://forum.zcashcommunity.com/t/example/1" },
    { categoryFailureCount: 1 },
    { topicErrorCount: 1 }
  ]) {
    assert.throws(
      () =>
        syncWorkerTestHooks.assertStagedMirrorComplete(
          { source: "forum-topics-batch", refreshId: "refresh-forum-error" },
          [{ sourceKind: "forum_topics", sourceId: "forum", rawPayload: {}, records: [], metadata }]
        ),
      /staged source mirror was incomplete/i
    );
  }
});

test("authoritative GitHub pruning is scoped to the configured repository and current manifest", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      return { rows: [], rowCount: 2 };
    }
  } as unknown as LockClient;
  const records = [
    {
      sourceKind: "github_issue",
      sourceId: "ZcashCommunityGrants/zcashcommunitygrants#351"
    },
    {
      sourceKind: "github_issue_comment",
      sourceId: "ZcashCommunityGrants/zcashcommunitygrants#351:comment:9001"
    }
  ];

  const result = await syncWorkerTestHooks.pruneGitHubRecordsAgainstManifest(client, records);

  assert.deepEqual(result, { authoritativeRecordCount: 2, recordsDeleted: 2 });
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /delete from source_records/);
  assert.match(queries[0].text, /left\(sr\.source_id, length\(\$1\)\) = \$1/);
  assert.match(queries[0].text, /jsonb_to_recordset/);
  assert.deepEqual(queries[0].values, [
    "ZcashCommunityGrants/zcashcommunitygrants#",
    JSON.stringify([
      {
        source_kind: "github_issue",
        source_id: "ZcashCommunityGrants/zcashcommunitygrants#351"
      },
      {
        source_kind: "github_issue_comment",
        source_id: "ZcashCommunityGrants/zcashcommunitygrants#351:comment:9001"
      }
    ])
  ]);
});

test("serializes authoritative source manifests with PostgreSQL recordset column names", () => {
  assert.equal(
    syncWorkerTestHooks.serializedSourceRecordManifest([{
      sourceKind: "github_issue",
      sourceId: "ZcashCommunityGrants/zcashcommunitygrants#351"
    }]),
    JSON.stringify([{
      source_kind: "github_issue",
      source_id: "ZcashCommunityGrants/zcashcommunitygrants#351"
    }])
  );
});

test("authoritative GitHub pruning refuses an empty issue manifest", async () => {
  const client = {
    async query() {
      throw new Error("query should not run");
    }
  } as unknown as LockClient;

  await assert.rejects(
    syncWorkerTestHooks.pruneGitHubRecordsAgainstManifest(client, []),
    /produced no issue records/i
  );
});

test("authoritative Google Sheet pruning removes rows absent from the complete mirror", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      return { rows: [], rowCount: 3 };
    }
  } as unknown as LockClient;
  const result = {
    sourceKind: "google_sheet",
    sourceId: "sheet-1",
    rawPayload: {
      tabs: [{ name: "grants", gid: "123", headers: ["Project"], rows: [{ Project: "Example" }] }]
    },
    records: [
      {
        sourceKind: "google_sheet_tab",
        sourceId: "sheet-1:123",
        rawPayload: {},
        metadata: { sheetId: "sheet-1", gid: "123" }
      },
      {
        sourceKind: "google_sheet_row",
        sourceId: "sheet-1:123:row:2",
        rawPayload: { Project: "Example" },
        metadata: { sheetId: "sheet-1", gid: "123", rowNumber: 2 }
      }
    ]
  };

  const pruned = await syncWorkerTestHooks.pruneGoogleSheetRecordsAgainstMirror(client, result);

  assert.deepEqual(pruned, {
    sheetId: "sheet-1",
    configuredGids: ["123"],
    authoritativeRecordCount: 2,
    recordsDeleted: 3
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /sr\.metadata->>'sheetId' = \$1/);
  assert.match(queries[0].text, /sr\.metadata->>'gid' = any\(\$2::text\[\]\)/);
  assert.match(queries[0].text, /jsonb_to_recordset/);
  assert.deepEqual(queries[0].values, [
    "sheet-1",
    ["123"],
    JSON.stringify([
      { source_kind: "google_sheet_tab", source_id: "sheet-1:123" },
      { source_kind: "google_sheet_row", source_id: "sheet-1:123:row:2" }
    ])
  ]);
  assert.doesNotMatch(queries[0].text, /metadata->>'gid' = 'unrelated'/);
});

test("authoritative Google Sheet pruning refuses a mirror without tab coverage", async () => {
  const client = {
    async query() {
      throw new Error("query should not run");
    }
  } as unknown as LockClient;

  await assert.rejects(
    syncWorkerTestHooks.pruneGoogleSheetRecordsAgainstMirror(client, {
      sourceKind: "google_sheet",
      sourceId: "sheet-1",
      rawPayload: {},
      records: []
    }),
    /no tab manifests/i
  );
});

test("authoritative Google Sheet pruning refuses an empty CSV tab", async () => {
  const client = {
    async query() {
      throw new Error("query should not run");
    }
  } as unknown as LockClient;

  await assert.rejects(
    syncWorkerTestHooks.pruneGoogleSheetRecordsAgainstMirror(client, {
      sourceKind: "google_sheet",
      sourceId: "sheet-1",
      rawPayload: { tabs: [{ name: "grants", gid: "123", headers: [], rows: [] }] },
      records: [{
        sourceKind: "google_sheet_tab",
        sourceId: "sheet-1:123",
        rawPayload: {},
        metadata: { sheetId: "sheet-1", gid: "123" }
      }]
    }),
    /empty or incomplete tab manifest/i
  );
});

test("Sheet-only refresh verifies the polled checksum before any storage mutation", () => {
  const result = completeSheetResult();
  const checksums = syncWorkerTestHooks.googleSheetChecksumsForStorage({}, [result]);
  const actual = checksums.get(result);

  assert.match(actual ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    syncWorkerTestHooks.googleSheetChecksumsForStorage(
      { expectedGoogleSheetChecksum: actual },
      [result]
    ).get(result),
    actual
  );
  assert.throws(
    () => syncWorkerTestHooks.googleSheetChecksumsForStorage(
      { expectedGoogleSheetChecksum: "f".repeat(64) },
      [result]
    ),
    /changed after its checksum check/i
  );
  assert.throws(
    () => syncWorkerTestHooks.googleSheetChecksumsForStorage(
      { expectedGoogleSheetChecksum: actual },
      []
    ),
    /without a Google Sheet mirror result/i
  );
});

test("authoritative Google Sheet pruning scopes deletion to returned tab gids", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    }
  } as unknown as LockClient;

  await syncWorkerTestHooks.pruneGoogleSheetRecordsAgainstMirror(client, {
    sourceKind: "google_sheet",
    sourceId: "sheet-1",
    rawPayload: {
      tabs: [{ name: "grants", gid: "123", headers: ["Project"], rows: [{ Project: "Only" }] }]
    },
    records: [
      {
        sourceKind: "google_sheet_tab",
        sourceId: "sheet-1:123",
        rawPayload: {},
        metadata: { sheetId: "sheet-1", gid: "123" }
      },
      {
        sourceKind: "google_sheet_row",
        sourceId: "sheet-1:123:row:2",
        rawPayload: { Project: "Only" },
        metadata: { sheetId: "sheet-1", gid: "123", rowNumber: 2 }
      }
    ]
  });

  assert.deepEqual(queries[0].values[1], ["123"]);
  assert.match(queries[0].text, /metadata->>'gid' = any\(\$2::text\[\]\)/);
  assert.match(
    queries[0].text,
    /not exists[\s\S]+current_record\.source_id = sr\.source_id/
  );
});

test("missing GitHub comments cause their issue to be verified before authoritative pruning", () => {
  const candidates = syncWorkerTestHooks.githubIssueVerificationCandidates([
    {
      source_kind: "github_issue_comment",
      source_id: "ZcashCommunityGrants/zcashcommunitygrants#351:comment:9001"
    },
    {
      source_kind: "github_issue",
      source_id: "ZcashCommunityGrants/zcashcommunitygrants#351"
    },
    {
      source_kind: "github_issue_comment",
      source_id: "ZcashCommunityGrants/zcashcommunitygrants#352:comment:9002"
    }
  ]);

  assert.deepEqual(candidates, [
    "ZcashCommunityGrants/zcashcommunitygrants#351",
    "ZcashCommunityGrants/zcashcommunitygrants#352"
  ]);
});

test("finalizes a scheduled refresh with stored request time and visible warning telemetry", async () => {
  const checksum = "a".repeat(64);
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const operations: string[] = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });

      if (text.includes("select result") && text.includes("from idempotency_keys")) {
        return {
          rows: [{
            result: {
              owner: "scheduled-refresh",
              parentSyncRunId: "00000000-0000-4000-8000-000000000030",
              requestedAt: "2026-07-15T07:00:00.000Z"
            }
          }],
          rowCount: 1
        };
      }

      if (text.includes("coalesce(sum(records_seen)")) {
        return {
          rows: [{
            records_seen: "10",
            records_created: "1",
            records_updated: "2",
            records_skipped: "7",
            warning_count: "2"
          }],
          rowCount: 1
        };
      }

      if (text.includes("jsonb_array_elements")) {
        return { rows: [{ checksum }], rowCount: 1 };
      }

      if (
        text.includes("update sync_runs") ||
        text.includes("delete from idempotency_keys") ||
        text.includes("insert into audit_events")
      ) {
        if (text.includes("update sync_runs")) {
          operations.push("parent-update");
        } else if (text.includes("delete from idempotency_keys")) {
          operations.push("lease-delete");
        }
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${text}`);
    }
  } as unknown as LockClient;

  const result = await syncWorkerTestHooks.releaseCorpusRefreshLease(client, {
    source: "corpus-refresh-complete",
    refreshId: "scheduled-refresh",
    trigger: "schedule"
  }, "completed", {
    writeGoogleSheetMarker: async (appliedChecksum) => {
      operations.push("marker-write");
      return {
        schemaVersion: 1,
        checksum: appliedChecksum,
        committedAt: "2026-07-15T07:30:00.000Z"
      };
    }
  });

  assert.equal(result.warningCount, 2);
  assert.equal(result.googleSheetMarker?.checksum, checksum);
  assert.ok(operations.indexOf("marker-write") > operations.indexOf("parent-update"));
  assert.ok(operations.indexOf("marker-write") < operations.indexOf("lease-delete"));
  const parentUpdate = queries.find((query) => query.text.includes("update sync_runs"));
  assert.ok(parentUpdate);
  assert.equal(parentUpdate.values[7], "Completed with 2 source coverage warning(s).");
  assert.deepEqual(JSON.parse(String(parentUpdate.values[6])), {
    phase: "corpus_refresh_pipeline",
    refreshId: "scheduled-refresh",
    refreshKind: "full",
    trigger: "schedule",
    requestedAt: "2026-07-15T07:00:00.000Z",
    requestedByPrincipalId: null,
    childCounts: {
      recordsSeen: 10,
      recordsCreated: 1,
      recordsUpdated: 2,
      recordsSkipped: 7
    },
    warningCount: 2,
    googleSheetContentChecksum: checksum
  });
});
