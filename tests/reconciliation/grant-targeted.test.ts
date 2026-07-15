import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { pool } from "../../lib/db";
import {
  grantReconciliationTestHooks as hooks,
  runTargetedGitHubReconciliation
} from "../../lib/reconciliation/grants";

type QueryCall = {
  text: string;
  values: readonly unknown[];
};

function queryResult(rows: unknown[] = [], rowCount = rows.length) {
  return {
    command: "",
    oid: 0,
    fields: [],
    rowCount,
    rows
  };
}

function sourceRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000351",
    source_kind: "github_issue",
    source_id: "ZcashCommunityGrants/zcashcommunitygrants#351",
    source_url: "https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues/351",
    checksum_sha256: "issue-checksum",
    title: "Grant Application — Targeted Privacy Grant",
    summary: "Targeted application",
    source_updated_at: "2026-07-15T12:00:00.000Z",
    raw_payload: JSON.stringify({
      title: "Grant Application — Targeted Privacy Grant",
      body: [
        "## Organization Name",
        "Targeted Team",
        "## Requested Grant Amount (USD)",
        "$12,500",
        "## Forum Link",
        "https://forum.zcashcommunity.com/t/targeted-privacy-grant/60001"
      ].join("\n"),
      html_url: "https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues/351",
      created_at: "2026-07-14T12:00:00.000Z"
    }),
    metadata: JSON.stringify({
      owner: "ZcashCommunityGrants",
      repo: "zcashcommunitygrants",
      number: 351,
      state: "open",
      labels: ["📋 Grant Application", "👀 Ready For ZCG Review"],
      labelDetails: [
        { name: "📋 Grant Application", color: "d4c849", description: "Application" },
        { name: "👀 Ready For ZCG Review", color: "006b75", description: "Review" }
      ],
      author: "targeted-team"
    }),
    ...overrides
  };
}

function commentRecord() {
  return {
    id: "00000000-0000-4000-8000-000000000352",
    source_kind: "github_issue_comment",
    source_id: "ZcashCommunityGrants/zcashcommunitygrants#351:comment:9001",
    source_url: "https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues/351#issuecomment-9001",
    checksum_sha256: "comment-checksum",
    title: "Comment on #351",
    summary: "Supporting discussion",
    source_updated_at: "2026-07-15T12:01:00.000Z",
    raw_payload: JSON.stringify({
      body: "Supporting discussion: https://forum.zcashcommunity.com/t/supporting-topic/60002"
    }),
    metadata: JSON.stringify({
      issueSourceId: "ZcashCommunityGrants/zcashcommunitygrants#351"
    })
  };
}

function generatedApplicationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000777",
    canonical_key: "github:ZcashCommunityGrants/zcashcommunitygrants#351",
    title: "Targeted Privacy Grant",
    applicant_name: "Targeted Team",
    github_issue_number: "351",
    github_issue_url: "https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues/351",
    github_state: "closed",
    normalized_status: "approved",
    requested_amount_usd: "12500",
    match_confidence: "1",
    source_summary: JSON.stringify({
      generatedBy: "grant_reconciliation_v1",
      githubSourceId: "ZcashCommunityGrants/zcashcommunitygrants#351",
      historicalRegistryStatus: "Approved"
    }),
    ...overrides
  };
}

function usePoolMock(t: TestContext) {
  const previousDatabaseDriver = process.env.DATABASE_DRIVER;
  delete process.env.DATABASE_DRIVER;
  t.after(() => {
    if (previousDatabaseDriver === undefined) {
      delete process.env.DATABASE_DRIVER;
    } else {
      process.env.DATABASE_DRIVER = previousDatabaseDriver;
    }
  });
}

test("targeted cleanup is application-local and preserves unrelated source-link classes", async () => {
  const applicationId = "00000000-0000-4000-8000-000000000777";
  const calls: QueryCall[] = [];
  const result = await hooks.clearTargetedGeneratedState(
    applicationId,
    async (text, values = []) => {
      calls.push({ text, values });
      return { rowCount: 2 };
    }
  );

  assert.deepEqual(result, { issuesDeleted: 2, linksDeleted: 2 });
  assert.equal(calls.length, 2);
  assert.match(calls[0].text, /canonical_id = \$1/);
  assert.match(calls[0].text, /details->>'generatedBy' = \$2/);
  assert.match(calls[0].text, /status in \('open', 'assigned'\)/);
  assert.deepEqual(calls[0].values, [applicationId, "grant_reconciliation_v1"]);
  assert.match(calls[1].text, /sl\.canonical_id = \$1/);
  assert.match(calls[1].text, /github_issue_comment/);
  assert.match(calls[1].text, /google_sheet_row/);
  assert.match(calls[1].text, /reconciliationGeneratedBy/);
  assert.doesNotMatch(calls[1].text, /decision_minutes/);
  assert.deepEqual(calls[1].values, [applicationId, "grant_reconciliation_v1"]);
});

test("reconciles one GitHub application and returns its affected application and Forum URLs", async (t) => {
  usePoolMock(t);
  const calls: QueryCall[] = [];
  const applicationId = "00000000-0000-4000-8000-000000000777";
  const forumSourceIds = new Map([
    ["https://forum.zcashcommunity.com/t/targeted-privacy-grant/60001", "00000000-0000-4000-8000-000000000801"],
    ["https://forum.zcashcommunity.com/t/supporting-topic/60002", "00000000-0000-4000-8000-000000000802"]
  ]);

  t.mock.method(pool, "query", async (text: string, values: readonly unknown[] = []) => {
    calls.push({ text, values });

    if (text.includes("insert into idempotency_keys")) {
      return queryResult([{ locked_until: "2026-07-15T13:00:00.000Z" }], 1);
    }

    if (text.includes("update idempotency_keys")) {
      return queryResult([{ key: hooks.grantReconciliationLeaseKey }], 1);
    }

    if (text.includes("where source_kind = 'github_issue'") && text.includes("source_id = $1")) {
      return queryResult([sourceRecord()]);
    }

    if (text.includes("where source_kind = 'github_issue_comment'")) {
      return queryResult([commentRecord()]);
    }

    if (text.includes("where source_kind = $1") && values[0] === "google_sheet_row") {
      return queryResult();
    }

    if (text.includes("select canonical_key, id from upserted")) {
      return queryResult([{
        canonical_key: "github:ZcashCommunityGrants/zcashcommunitygrants#351",
        id: applicationId
      }]);
    }

    if (text.includes("insert into source_records") && text.includes("'forum_link'")) {
      const links = JSON.parse(String(values[0])) as Array<{ url: string }>;
      return queryResult(links.map(({ url }) => ({ source_id: url, id: forumSourceIds.get(url) })));
    }

    if (text.includes("affected_count from inserted") || text.includes("affected_count from deleted")) {
      return queryResult([{ affected_count: "0" }]);
    }

    return queryResult();
  });

  const result = await runTargetedGitHubReconciliation({
    githubSourceId: "ZcashCommunityGrants/zcashcommunitygrants#351"
  });

  assert.deepEqual(result, {
    ok: true,
    requiresFullReconciliation: false,
    githubSourceId: "ZcashCommunityGrants/zcashcommunitygrants#351",
    applicationIds: [applicationId],
    discoveredForumUrls: [
      "https://forum.zcashcommunity.com/t/supporting-topic/60002",
      "https://forum.zcashcommunity.com/t/targeted-privacy-grant/60001"
    ]
  });

  const applicationUpsert = calls.find((call) => call.text.includes("select canonical_key, id from upserted"));
  assert.ok(applicationUpsert);
  const applicationPayload = JSON.parse(String(applicationUpsert.values[0])) as Array<{
    canonical_key: string;
  }>;
  assert.deepEqual(applicationPayload.map(({ canonical_key }) => canonical_key), [
    "github:ZcashCommunityGrants/zcashcommunitygrants#351"
  ]);

  const linkCleanup = calls.find((call) => call.text.includes("delete from source_links sl"));
  assert.ok(linkCleanup);
  assert.deepEqual(linkCleanup.values, [applicationId, "grant_reconciliation_v1"]);
  assert.equal(calls.some((call) => /delete from source_links where canonical_type/.test(call.text)), false);
  assert.equal(calls.some((call) => /delete from source_records/.test(call.text)), false);
  assert.equal(calls.some((call) => /delete from grant_applications/.test(call.text)), false);

  const grantDelete = calls.find((call) => call.text.includes("delete from grants where application_id = $1"));
  assert.deepEqual(grantDelete?.values, [applicationId]);

  const labelDelete = calls.find((call) => call.text.includes("delete from grant_application_github_labels"));
  assert.ok(labelDelete);
  assert.deepEqual(JSON.parse(String(labelDelete.values[0])), [{ application_id: applicationId }]);
  assert.equal(calls.filter((call) => call.text.includes("decision_type = 'link_source'")).length, 1);
  assert.equal(calls.filter((call) => call.text.includes("decision_type = 'unlink_source'")).length, 1);
});

test("retires a generated canonical application when its GitHub source is missing", async (t) => {
  usePoolMock(t);
  const calls: QueryCall[] = [];
  const applicationId = "00000000-0000-4000-8000-000000000777";

  t.mock.method(pool, "query", async (text: string, values: readonly unknown[] = []) => {
    calls.push({ text, values });

    if (text.includes("insert into idempotency_keys")) {
      return queryResult([{ locked_until: "2026-07-15T13:00:00.000Z" }], 1);
    }

    if (text.includes("update idempotency_keys")) {
      return queryResult([{ key: hooks.grantReconciliationLeaseKey }], 1);
    }

    if (text.includes("from grant_applications ga") && text.includes("source_summary->>'generatedBy'")) {
      return queryResult([generatedApplicationRow()]);
    }

    if (text.includes("select canonical_key, id from upserted")) {
      return queryResult([{
        canonical_key: "github:ZcashCommunityGrants/zcashcommunitygrants#351",
        id: applicationId
      }]);
    }

    if (text.includes("delete from grants") && text.includes("jsonb_to_recordset")) {
      return queryResult([], 1);
    }

    if (text.includes("affected_count from inserted") || text.includes("affected_count from deleted")) {
      return queryResult([{ affected_count: "0" }]);
    }

    return queryResult();
  });

  const result = await runTargetedGitHubReconciliation({
    githubSourceId: "ZcashCommunityGrants/zcashcommunitygrants#351"
  });

  assert.deepEqual(result, {
    ok: true,
    requiresFullReconciliation: true,
    reason: "missing_or_tombstoned_source",
    githubSourceId: "ZcashCommunityGrants/zcashcommunitygrants#351",
    applicationIds: [applicationId],
    discoveredForumUrls: []
  });

  const applicationUpsert = calls.find((call) => call.text.includes("select canonical_key, id from upserted"));
  assert.ok(applicationUpsert);
  assert.match(applicationUpsert.text, /insert into grant_application_status_events/);
  const [retirement] = JSON.parse(String(applicationUpsert.values[0])) as Array<{
    canonical_key: string;
    normalized_status: string;
    source_summary: {
      generatedBy: string;
      reconciliationState: string;
      retirement: { reason: string; previousStatus: string };
    };
    status_source_field: string;
  }>;
  assert.equal(retirement.canonical_key, "github:ZcashCommunityGrants/zcashcommunitygrants#351");
  assert.equal(retirement.normalized_status, "unknown");
  assert.equal(retirement.source_summary.generatedBy, "grant_reconciliation_v1");
  assert.equal(retirement.source_summary.reconciliationState, "retired");
  assert.equal(retirement.source_summary.retirement.reason, "missing_or_tombstoned_source");
  assert.equal(retirement.source_summary.retirement.previousStatus, "approved");
  assert.equal(retirement.status_source_field, "source_availability");

  const grantDelete = calls.find(
    (call) => call.text.includes("delete from grants") && call.text.includes("jsonb_to_recordset")
  );
  assert.ok(grantDelete);
  assert.deepEqual(JSON.parse(String(grantDelete.values[0])), [{ application_id: applicationId }]);
  assert.equal(calls.some((call) => call.text.includes("delete from grant_applications")), false);
  assert.equal(calls.some((call) => call.text.includes("delete from reconciliation_issues")), true);
  assert.equal(calls.some((call) => call.text.includes("delete from grant_application_github_labels")), true);
  assert.equal(calls.filter((call) => call.text.includes("decision_type = 'link_source'")).length, 1);
  assert.equal(calls.filter((call) => call.text.includes("decision_type = 'unlink_source'")).length, 1);
});

test("a missing source without a generated canonical application requests full reconciliation without guessing", async (t) => {
  usePoolMock(t);
  const calls: QueryCall[] = [];

  t.mock.method(pool, "query", async (text: string, values: readonly unknown[] = []) => {
    calls.push({ text, values });

    if (text.includes("insert into idempotency_keys")) {
      return queryResult([{ locked_until: "2026-07-15T13:00:00.000Z" }], 1);
    }

    if (text.includes("update idempotency_keys")) {
      return queryResult([{ key: hooks.grantReconciliationLeaseKey }], 1);
    }

    return queryResult();
  });

  const result = await runTargetedGitHubReconciliation({
    githubSourceId: "ZcashCommunityGrants/zcashcommunitygrants#999"
  });

  assert.deepEqual(result, {
    ok: true,
    requiresFullReconciliation: true,
    reason: "missing_or_tombstoned_source",
    githubSourceId: "ZcashCommunityGrants/zcashcommunitygrants#999",
    applicationIds: [],
    discoveredForumUrls: []
  });
  assert.equal(calls.some((call) => /delete from|insert into grant_applications|insert into grants/.test(call.text)), false);
});

test("nightly retirement selection is limited to generated GitHub applications outside the active set", async (t) => {
  usePoolMock(t);
  const calls: QueryCall[] = [];

  t.mock.method(pool, "query", async (text: string, values: readonly unknown[] = []) => {
    calls.push({ text, values });
    return queryResult();
  });

  await hooks.fetchGeneratedGitHubApplicationsForRetirement({
    activeCanonicalKeys: ["github:ZcashCommunityGrants/zcashcommunitygrants#351"]
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /canonical_key like 'github:%'/);
  assert.match(calls[0].text, /source_summary->>'generatedBy' = \$1/);
  assert.match(calls[0].text, /not exists/);
  assert.deepEqual(calls[0].values, [
    "grant_reconciliation_v1",
    JSON.stringify(["github:ZcashCommunityGrants/zcashcommunitygrants#351"])
  ]);
});

test("an explicit tombstone also requests a full reconciliation without cleanup", async (t) => {
  usePoolMock(t);
  const calls: QueryCall[] = [];

  t.mock.method(pool, "query", async (text: string, values: readonly unknown[] = []) => {
    calls.push({ text, values });

    if (text.includes("insert into idempotency_keys")) {
      return queryResult([{ locked_until: "2026-07-15T13:00:00.000Z" }], 1);
    }

    if (text.includes("update idempotency_keys")) {
      return queryResult([{ key: hooks.grantReconciliationLeaseKey }], 1);
    }

    if (text.includes("where source_kind = 'github_issue'")) {
      return queryResult([sourceRecord({ metadata: JSON.stringify({ status: "not_found" }) })]);
    }

    return queryResult();
  });

  const result = await runTargetedGitHubReconciliation({
    githubSourceId: "ZcashCommunityGrants/zcashcommunitygrants#351"
  });

  assert.equal(result.requiresFullReconciliation, true);
  assert.deepEqual(result.applicationIds, []);
  assert.equal(calls.some((call) => call.text.includes("delete from reconciliation_issues")), false);
  assert.equal(calls.some((call) => call.text.includes("insert into grant_applications")), false);
});
