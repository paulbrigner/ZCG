import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../../lib/db";
import {
  applicationPlatformIdentity,
  existingHistoricalKeysByPlatform,
  historicalIdentityKey,
  type ExistingHistoricalApplicationIdentity
} from "../../lib/reconciliation/application-identity";
import { grantReconciliationTestHooks as hooks } from "../../lib/reconciliation/grants";

const repo = "https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues/";

function registryRow(id: string, fields: Record<string, string>) {
  return {
    id,
    source_kind: "google_sheet_row",
    source_id: `sheet:1164534734:row:${id}`,
    source_url: "https://docs.google.com/spreadsheets/d/example/edit?gid=1164534734",
    checksum_sha256: id,
    title: fields["Proposal Title"],
    summary: null,
    source_updated_at: null,
    // PostgreSQL jsonb reorders object keys: Country precedes Date Submitted.
    raw_payload: JSON.stringify({ Country: "", ...fields }),
    metadata: JSON.stringify({ gid: "1164534734", tabName: "all_grants_tracking" })
  };
}

function arabiaRows(numbers: [number, number] = [380, 400]) {
  return [
    registryRow("old", {
      "Proposal Title": "Zcash Arabia (August to December 2026)",
      "Applicant(s)": "ZcashArabia",
      "Date Submitted": "8/1/2026",
      "Grant Status": "Rejected",
      "Grant Platform Link": `${repo}${numbers[0]}`,
      "Forum Link": "https://forum.zcashcommunity.com/t/arabia-original/56866"
    }),
    registryRow("new", {
      "Proposal Title": "Zcash Arabia (August to December 2026",
      "Applicant(s)": "ZcashArabia",
      "Date Submitted": "8/24/2026",
      "Grant Status": "Approved",
      "Grant Platform Link": `${repo}${numbers[1]}#issuecomment-123`,
      "Forum Link": "https://forum.zcashcommunity.com/t/arabia-revised/57170"
    })
  ];
}

function githubApplication(number: number, title = "Zcash Arabia (August to December 2026") {
  const app = hooks.parseGitHubApplication({
    ...registryRow("github", { "Proposal Title": title }),
    source_kind: "github_issue",
    source_id: `ZcashCommunityGrants/zcashcommunitygrants#${number}`,
    source_url: `${repo}${number}`,
    raw_payload: JSON.stringify({ title: `Grant Application - ${title}`, html_url: `${repo}${number}`, body: "" }),
    metadata: JSON.stringify({ number, state: "open", labels: ["Grant Approved"] })
  });
  assert.ok(app);
  return app;
}

function existing(key: string, link: string, overrides: Partial<ExistingHistoricalApplicationIdentity> = {}) {
  return {
    canonical_key: `sheet-all-grants:${key}`,
    platform_link: link,
    created_at: "2026-07-01 00:00:00+00",
    updated_at: "2026-07-01 00:00:00+00",
    manual_decisions: 0,
    ...overrides
  };
}

test("reads submission dates by header and separates same-title resubmissions", () => {
  const groups = [...hooks.buildHistoricalApplicationGroups(arabiaRows()).values()];
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => [g.submittedDate, g.status, g.rows.map((r) => r.id)]), [
    ["8/1/2026", "Rejected", ["old"]],
    ["8/24/2026", "Approved", ["new"]]
  ]);
});

test("the approved Arabia attempt only inherits its own registry decision and primary Forum topic", () => {
  for (const numbers of [[380, 400], [289, 301]] as Array<[number, number]>) {
    const groups = hooks.buildHistoricalApplicationGroups(arabiaRows(numbers));
    const plan = hooks.planGitHubApplication({
      app: githubApplication(numbers[1]), githubComments: [], historicalGroups: groups,
      historicalByGitHubIssueUrl: hooks.buildHistoricalApplicationsByGitHubIssue(groups.values()),
      paymentDetailGroups: new Map(), hasHistoricalRegistry: true
    }).planned;
    assert.equal(plan.application.normalizedStatus, "approved");
    assert.equal(plan.application.sourceSummary.historicalRegistrySubmittedDate, "8/24/2026");
    assert.equal(plan.application.sourceSummary.historicalRegistryRowCount, 1);
    assert.deepEqual(plan.links.map((l) => l.sourceRecordId), ["github", "new"]);
    assert.deepEqual(plan.forumLinks.filter((l) => l.relationshipRole === "primary_forum_thread").map((l) => l.url), [
      "https://forum.zcashcommunity.com/t/arabia-revised/57170"
    ]);
    assert.ok(plan.grant);
    assert.ok(!plan.issues.some((i) => i.issueType === "status_conflict"));
  }
});

test("distinct legacy proposal IDs stay separate even with blank dates and identical titles", () => {
  const rows = ["47288777", "48513853"].map((id) => registryRow(id, {
    "Proposal Title": "Zcash Global en Español", "Applicant(s)": "Same team", "Date Submitted": "",
    "Grant Platform Link": `https://zcashgrants.org/gallery/collection/${id}/`
  }));
  assert.equal(hooks.buildHistoricalApplicationGroups(rows).size, 2);
});

test("title, date, and field-order edits do not create a new identity", () => {
  const before = arabiaRows()[1];
  const after = { ...before, raw_payload: JSON.stringify({
    "Grant Platform Link": `${repo}400`, "Date Submitted": "8/25/2026",
    "Proposal Title": "Zcash Arabia revised title", "Applicant(s)": "New display name", Country: "Egypt"
  }) };
  const first = [...hooks.buildHistoricalApplicationGroups([before]).values()][0];
  const second = [...hooks.buildHistoricalApplicationGroups([after]).values()][0];
  assert.equal(second.canonicalKey, first.canonicalKey);
  assert.equal(second.key, first.key);
  assert.equal(second.submittedDate, "8/25/2026");
});

test("preserves opaque legacy identifiers and distinguishes missing-identifier rows", () => {
  assert.equal(applicationPlatformIdentity(" NA "), "NA");
  assert.equal(applicationPlatformIdentity("https://legacy.test/proposals/123/"), "https://legacy.test/proposals/123");
  assert.notEqual(historicalIdentityKey(null, "row:1"), historicalIdentityKey(null, "row:2"));
  assert.equal(applicationPlatformIdentity(`${repo}400#issuecomment-1`), applicationPlatformIdentity(`${repo}400/`));
});

test("reuses the existing primary-identity key even after a title/date correction", () => {
  const keys = existingHistoricalKeysByPlatform([existing("original-key", `${repo}400`)]);
  const group = [...hooks.buildHistoricalApplicationGroups([arabiaRows()[1]], keys).values()][0];
  assert.equal(group.canonicalKey, "sheet-all-grants:original-key");
});

test("keeps the manual-decision owner instead of the newer generated duplicate", () => {
  const keys = existingHistoricalKeysByPlatform([
    existing("original-key", `${repo}400`, { manual_decisions: "1" }),
    existing("new-duplicate", `${repo}400#issuecomment-4`, { updated_at: "2026-09-01 00:00:00+00" })
  ]);
  assert.equal(keys.get(applicationPlatformIdentity(`${repo}400`)!), "sheet-all-grants:original-key");
});

test("persisted key lookup includes relationship targets and reads primary identity without raw evidence payloads", async (t) => {
  const previousDriver = process.env.DATABASE_DRIVER;
  delete process.env.DATABASE_DRIVER;
  t.after(() => {
    if (previousDriver === undefined) delete process.env.DATABASE_DRIVER;
    else process.env.DATABASE_DRIVER = previousDriver;
  });
  t.mock.method(pool, "query", async (sql: string) => {
    assert.match(sql, /d\.related_canonical_key = ga\.canonical_key/);
    assert.match(sql, /d\.status = 'active'/);
    assert.match(sql, /source_summary->>'historicalRegistryGrantPlatformLink'/);
    assert.doesNotMatch(sql, /raw_payload|source_links/);
    return { rows: [existing("reviewed", `${repo}400`, { manual_decisions: 1 })] };
  });
  const keys = await hooks.fetchExistingHistoricalApplicationKeys();
  assert.equal([...keys.values()][0], "sheet-all-grants:reviewed");
});


test("unreviewed duplicate selection is deterministic and uses the most recently active record", () => {
  const rows = [existing("old", `${repo}400`), existing("current", `${repo}400`, { updated_at: "2026-09-01 00:00:00+00" })];
  assert.deepEqual(existingHistoricalKeysByPlatform(rows), existingHistoricalKeysByPlatform([...rows].reverse()));
  assert.equal([...existingHistoricalKeysByPlatform(rows).values()][0], "sheet-all-grants:current");
});

test("conflicting saved decision owners fail before choosing an identity", () => {
  assert.throws(() => existingHistoricalKeysByPlatform([
    existing("first", `${repo}400`, { manual_decisions: 1 }),
    existing("second", `${repo}400`, { manual_decisions: 2 })
  ]), /multiple records with active manual decisions/);
});

test("a similar title cannot override an explicit link to a different issue or repository", () => {
  const app = githubApplication(400);
  for (const link of [`${repo}380`, "https://github.com/OtherOwner/another-repo/issues/400"]) {
    const row = registryRow("other", {
      "Proposal Title": app.displayTitle, "Grant Platform Link": link, "Grant Status": "Rejected"
    });
    const groups = hooks.buildHistoricalApplicationGroups([row]);
    assert.equal(hooks.bestHistoricalApplicationMatch(app, groups, hooks.buildHistoricalApplicationsByGitHubIssue(groups.values())), null);
  }
});

test("an exact GitHub identifier takes precedence over a misleading title", () => {
  const row = registryRow("renamed", { "Proposal Title": "Renamed application", "Grant Platform Link": `${repo}400#issuecomment-7` });
  const groups = hooks.buildHistoricalApplicationGroups([row]);
  const match = hooks.bestHistoricalApplicationMatch(githubApplication(400), groups, hooks.buildHistoricalApplicationsByGitHubIssue(groups.values()));
  assert.equal(match?.group.rows[0].id, "renamed");
  assert.equal(match?.confidence, 1);
});
