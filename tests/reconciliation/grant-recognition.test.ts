import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { pool } from "../../lib/db";
import { grantReconciliationTestHooks as hooks, runGrantReconciliation, runTargetedGitHubReconciliation } from "../../lib/reconciliation/grants";

const issueUrl = "https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues/378";
const sourceId = "ZcashCommunityGrants/zcashcommunitygrants#378";
const canonicalKey = "sheet-all-grants:build-buddies-existing";
const title = "Build Buddies x Zcash: Privacy Education and Community Adoption in Latin America and Asia";
const closureLabel = "Closed - Did Not Follow Process";
const issue = {
  id: "00000000-0000-4000-8000-000000000378", source_kind: "github_issue", source_id: sourceId,
  source_url: issueUrl, checksum_sha256: "issue-checksum", title, summary: null, source_updated_at: null,
  raw_payload: JSON.stringify({ title, html_url: issueUrl, body: "### Requested Grant Amount (USD)\n10000", labels: [{ name: closureLabel }] }),
  metadata: JSON.stringify({ number: 378, state: "closed" })
};
const sheet = {
  ...issue, id: "00000000-0000-4000-8000-000000000379", source_kind: "google_sheet_row", source_id: "sheet:all-grants:378",
  source_url: "https://docs.google.com/spreadsheets/d/example/edit?gid=1164534734",
  raw_payload: JSON.stringify({ "Proposal Title": title, "Grant Platform Link": `${issueUrl.toLowerCase()}#issuecomment-123`, "Grant Status": "Filtered" }),
  metadata: JSON.stringify({ gid: "1164534734", tabName: "all_grants_tracking" })
};

function registry() {
  const groups = hooks.buildHistoricalApplicationGroups([sheet], new Map([[issueUrl.toLowerCase(), canonicalKey]]));
  return { groups, byUrl: hooks.buildHistoricalApplicationsByGitHubIssue(groups.values()) };
}

test("an explicit registry identity recognizes #378 despite its title and replacement closure label", () => {
  const { groups, byUrl } = registry();
  assert.equal(hooks.parseGitHubApplication(issue), null);
  const app = hooks.parseGitHubApplication(issue, byUrl);
  assert.ok(app);
  assert.equal(hooks.statusFromGitHub(app), "filtered");
  const result = hooks.planGitHubApplication({ app, githubComments: [], historicalGroups: groups,
    historicalByGitHubIssueUrl: byUrl, paymentDetailGroups: new Map(), hasHistoricalRegistry: true });
  assert.equal(result.matchedHistoricalApplication, true);
  assert.equal(result.planned.application.canonicalKey, canonicalKey);
  assert.equal(result.planned.application.normalizedStatus, "filtered");
  assert.equal(result.planned.application.githubState, "closed");
  assert.equal(result.planned.application.requestedAmountUsd, 10000);
  assert.equal(result.planned.grant, null);
  assert.deepEqual(result.planned.links.map(link => link.sourceRecordId), [issue.id, sheet.id]);
  assert.equal(result.planned.githubLabels[0].labelName, closureLabel);
  assert.equal(result.planned.githubLabels[0].labelStatus, "did_not_follow_process");
  assert.deepEqual(result.planned.issues, []);
});

test("registry recognition requires the exact repository and issue, and never assigns committee review", () => {
  const { byUrl } = registry();
  for (const otherUrl of [issueUrl.replace("/378", "/379"), issueUrl.replace("/zcashcommunitygrants/", "/another-repo/"),
    issueUrl.replace("github.com", "github.com.example.org")]) {
    assert.equal(hooks.parseGitHubApplication({ ...issue, source_url: otherUrl,
      raw_payload: JSON.stringify({ title, html_url: otherUrl, labels: [{ name: closureLabel }] }) }, byUrl), null);
  }
  const unassigned = hooks.parseGitHubApplication({ ...issue,
    raw_payload: JSON.stringify({ title, html_url: issueUrl }), metadata: JSON.stringify({ number: 378, state: "open" }) }, byUrl);
  assert.ok(unassigned);
  assert.equal(hooks.statusFromGitHub(unassigned), "submitted");
  assert.equal(hooks.statusFromGitHub({ ...unassigned, labels: [closureLabel, "Grant Application", "Ready For ZCG Review"] }), "filtered");
  assert.equal(hooks.parseGitHubApplication({ ...issue, metadata: JSON.stringify({ tombstone: true }) }, byUrl), null);
});

test("existing GitHub owners retain their key even when an older registry duplicate exists", () => {
  const { groups, byUrl } = registry();
  const app = hooks.parseGitHubApplication(issue, byUrl)!;
  const nativeKey = `github:${sourceId}`;
  const result = hooks.planGitHubApplication({ app, githubComments: [], historicalGroups: groups,
    historicalByGitHubIssueUrl: byUrl, paymentDetailGroups: new Map(), hasHistoricalRegistry: true,
    existingGitHubCanonicalKeys: new Set([nativeKey]) });
  assert.equal(result.planned.application.canonicalKey, nativeKey);
});

test("PostgreSQL full and targeted reconciliation link #378 without replacing its application or reopening review", {
  skip: process.env.ZCG_TEST_DATABASE_URL ? false : "set ZCG_TEST_DATABASE_URL for isolated PostgreSQL validation",
  timeout: 60000
}, async (t) => {
  const client = new pg.Client({ connectionString: process.env.ZCG_TEST_DATABASE_URL });
  await client.connect();
  const schema = `zcg_recognition_${randomUUID().replaceAll("-", "")}`;
  const applicationId = randomUUID();
  const previousDriver = process.env.DATABASE_DRIVER;
  delete process.env.DATABASE_DRIVER;
  t.mock.method(pool, "query", (sql: string, values: readonly unknown[] = []) => client.query(sql, [...values]));
  try {
    await client.query("create extension if not exists pgcrypto with schema public");
    await client.query(`create schema "${schema}"`);
    await client.query(`set search_path to "${schema}", public`);
    for (const file of ["0001_phase0_foundation.sql", "0002_phase1_source_mirroring.sql", "0003_phase2_canonical_reconciliation.sql",
      "0007_grant_application_github_labels.sql", "0008_manual_reconciliation_decisions.sql", "0009_source_link_relationship_roles.sql",
      "0012_grant_decision_minutes.sql", "0017_grant_application_status_history.sql", "0018_grant_milestone_disbursements.sql"]) {
      await client.query((await fs.readFile(`migrations/${file}`, "utf8")).replace("create extension if not exists pgcrypto;", ""));
    }
    for (const record of [issue, sheet]) {
      await client.query(`insert into source_records(id,source_kind,source_id,source_url,title,checksum_sha256,raw_payload,metadata)
        values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`, [record.id, record.source_kind, record.source_id, record.source_url,
        record.title, record.checksum_sha256, record.raw_payload, record.metadata]);
    }
    await client.query(`insert into grant_applications(id,canonical_key,title,github_issue_number,normalized_status,source_summary)
      values ($1,$2,$3,378,'filtered',$4::jsonb)`, [applicationId, canonicalKey, title, JSON.stringify({
      generatedBy: "grant_reconciliation_v1", historicalRegistryGrantPlatformLink: issueUrl
    })]);
    await client.query(`insert into reconciliation_issues(issue_type,severity,status,summary,canonical_type,canonical_id,source_record_id,details)
      values ('missing_github_source_mirror','warning','open','Missing issue','grant_application',$1,$2,'{"generatedBy":"grant_reconciliation_v1"}')`, [applicationId, sheet.id]);
    const before = (await client.query("select id,raw_payload,metadata from source_records order by id")).rows;
    const verify = async () => {
      const apps = (await client.query("select id,canonical_key,normalized_status,github_state from grant_applications where github_issue_number=378")).rows;
      assert.deepEqual(apps, [{ id: applicationId, canonical_key: canonicalKey, normalized_status: "filtered", github_state: "closed" }]);
      assert.equal((await client.query("select count(*)::int as n from grants where application_id=$1", [applicationId])).rows[0].n, 0);
      assert.equal((await client.query("select count(*)::int as n from source_links where canonical_id=$1 and source_record_id in ($2,$3)", [applicationId, issue.id, sheet.id])).rows[0].n, 2);
      assert.equal((await client.query("select count(*)::int as n from reconciliation_issues where canonical_id=$1 and status in ('open','assigned')", [applicationId])).rows[0].n, 0);
      assert.deepEqual((await client.query("select label_name,label_status from grant_application_github_labels where application_id=$1", [applicationId])).rows,
        [{ label_name: closureLabel, label_status: "did_not_follow_process" }]);
      assert.deepEqual((await client.query("select id,raw_payload,metadata from source_records where id in ($1,$2) order by id", [issue.id, sheet.id])).rows, before);
    };
    await runGrantReconciliation();
    await verify();
    // A later title change must not switch the preserved registry identity to a new GitHub key.
    await client.query("update source_records set raw_payload=jsonb_set(raw_payload,'{title}','\"Grant Application - Build Buddies\"') where id=$1", [issue.id]);
    const result = await runTargetedGitHubReconciliation({ githubSourceId: sourceId });
    assert.equal(result.requiresFullReconciliation, false);
    assert.deepEqual(result.applicationIds, [applicationId]);
    await client.query("update source_records set raw_payload=$2::jsonb where id=$1", [issue.id, issue.raw_payload]);
    await verify();
    await runGrantReconciliation();
    await verify();
    await client.query(`insert into reconciliation_decisions(decision_key,decision_type,source_kind,source_id,canonical_key,rationale)
      values ('keep-registry-owner','link_source','google_sheet_row',$1,$2,'Preserve confirmed registry source')`, [sheet.source_id, canonicalKey]);
    const decisionBefore = (await client.query("select to_jsonb(d) as data from reconciliation_decisions d")).rows;
    const reviewBody = { title, html_url: issueUrl, labels: [{ name: "Grant Application" }, { name: "Ready For ZCG Review" }] };
    const reviewSheet = { ...JSON.parse(sheet.raw_payload), "Grant Status": "ZCG to discuss" };
    for (const disappearance of ["missing", "tombstoned", "both_sources_missing", "both_sources_missing_full", "registry_missing_targeted", "registry_missing_full"]) {
      await client.query(`insert into source_records(id,source_kind,source_id,source_url,title,raw_payload,metadata)
        values ($1,'github_issue',$2,$3,$4,$5::jsonb,'{"number":378,"state":"open"}')
        on conflict (id) do update set raw_payload=excluded.raw_payload,metadata=excluded.metadata`,
      [issue.id, sourceId, issueUrl, title, JSON.stringify(reviewBody)]);
      await client.query(`insert into source_records(id,source_kind,source_id,source_url,title,raw_payload,metadata)
        values ($1,'google_sheet_row',$2,$3,$4,$5::jsonb,$6::jsonb)
        on conflict (id) do update set raw_payload=excluded.raw_payload`,
      [sheet.id, sheet.source_id, sheet.source_url, title, JSON.stringify(reviewSheet), sheet.metadata]);
      await runTargetedGitHubReconciliation({ githubSourceId: sourceId });
      assert.equal((await client.query("select normalized_status from grant_applications where id=$1", [applicationId])).rows[0].normalized_status, "under_review");

      if (disappearance.startsWith("registry_missing")) {
        await client.query("delete from source_records where id=$1", [sheet.id]);
        for (let repeat = 0; repeat < 3; repeat += 1) {
          if (repeat === 1) await client.query("update source_records set raw_payload=$2::jsonb,metadata=$3::jsonb where id=$1", [issue.id, issue.raw_payload, issue.metadata]);
          if (disappearance.endsWith("full")) await runGrantReconciliation();
          else {
            const result = await runTargetedGitHubReconciliation({ githubSourceId: sourceId });
            assert.equal(result.requiresFullReconciliation, false);
            assert.deepEqual(result.applicationIds, [applicationId]);
          }
          assert.deepEqual((await client.query("select id,canonical_key,normalized_status from grant_applications where github_issue_number=378")).rows,
            [{ id: applicationId, canonical_key: canonicalKey, normalized_status: repeat === 0 ? "under_review" : "filtered" }]);
        }
        assert.deepEqual((await client.query("select to_jsonb(d) as data from reconciliation_decisions d")).rows, decisionBefore);
        // The registry can return after GitHub has disappeared: its identity
        // must still resolve to the same owner after the intervening gap.
        await client.query("delete from source_records where id=$1", [issue.id]);
        await client.query(`insert into source_records(id,source_kind,source_id,source_url,title,raw_payload,metadata)
          values ($1,'google_sheet_row',$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [sheet.id, sheet.source_id, sheet.source_url, title, JSON.stringify(reviewSheet), sheet.metadata]);
        await runGrantReconciliation();
        assert.deepEqual((await client.query("select id,canonical_key,normalized_status from grant_applications where github_issue_number=378")).rows,
          [{ id: applicationId, canonical_key: canonicalKey, normalized_status: "submitted" }]);
        continue;
      }
      if (disappearance === "tombstoned") await client.query("update source_records set metadata=metadata || '{\"tombstone\":true}'::jsonb where id=$1", [issue.id]);
      else await client.query("delete from source_records where id=$1", [issue.id]);
      const bothMissing = disappearance.startsWith("both_sources_missing");
      if (bothMissing) await client.query("delete from source_records where id=$1", [sheet.id]);
      if (disappearance.endsWith("full")) await runGrantReconciliation();
      else {
        const retired = await runTargetedGitHubReconciliation({ githubSourceId: sourceId });
        assert.equal(retired.requiresFullReconciliation, true);
        assert.deepEqual(retired.applicationIds, [applicationId]);
      }
      assert.deepEqual((await client.query("select id,canonical_key,normalized_status,github_state from grant_applications where id=$1", [applicationId])).rows,
        [{ id: applicationId, canonical_key: canonicalKey, normalized_status: bothMissing ? "unknown" : "submitted", github_state: null }]);
      assert.equal((await client.query("select count(*)::int as n from grant_application_github_labels where application_id=$1", [applicationId])).rows[0].n, 0);
      assert.deepEqual((await client.query("select to_jsonb(d) as data from reconciliation_decisions d")).rows, decisionBefore);
      if (!bothMissing) {
        assert.equal((await client.query("select count(*)::int as n from source_links where canonical_id=$1 and source_record_id=$2", [applicationId, sheet.id])).rows[0].n, 1);
        // Full reconciliation must agree, including a tombstone with retained old title/labels.
        await runGrantReconciliation();
        assert.equal((await client.query("select normalized_status from grant_applications where id=$1", [applicationId])).rows[0].normalized_status, "submitted");
      }
    }
  } finally {
    if (previousDriver === undefined) delete process.env.DATABASE_DRIVER;
    else process.env.DATABASE_DRIVER = previousDriver;
    await client.query(`drop schema if exists "${schema}" cascade`);
    await client.end();
  }
});
