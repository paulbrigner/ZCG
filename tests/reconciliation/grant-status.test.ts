import assert from "node:assert/strict";
import test from "node:test";
import { grantReconciliationTestHooks as hooks } from "../../lib/reconciliation/grants";

test("a Sheet review status cannot promote an application without official GitHub assignment", () => {
  assert.equal(hooks.resolveCanonicalStatus("under_review", "declined"), "declined");
  assert.equal(hooks.resolveCanonicalStatus("under_review", "approved"), "approved");
  assert.equal(hooks.resolveCanonicalStatus("under_review", "under_review"), "under_review");
  assert.equal(hooks.resolveCanonicalStatus("under_review", "submitted"), "submitted");
  assert.equal(hooks.resolveCanonicalStatus("under_review", "unknown"), "submitted");
  assert.equal(hooks.resolveCanonicalStatus("approved", "declined"), "approved");
  assert.equal(hooks.resolveCanonicalStatus("declined", "approved"), "declined");
  assert.equal(hooks.resolveCanonicalStatus("completed", "approved"), "completed");
  assert.equal(hooks.resolveCanonicalStatus("unknown", "declined"), "declined");
  assert.equal(hooks.resolveCanonicalStatus(null, "submitted"), "submitted");
});

test("GitHub review status requires both exact workflow labels", () => {
  assert.equal(hooks.statusFromGitHub({
    labels: ["📋 Grant Application", "👀 Ready For ZCG Review"],
    state: "open"
  } as never), "under_review");
  assert.equal(hooks.statusFromGitHub({
    labels: ["👀 Ready For ZCG Review"],
    state: "open"
  } as never), "submitted");
  assert.equal(hooks.statusFromGitHub({
    labels: ["📋 Grant Application", "Ready"],
    state: "open"
  } as never), "submitted");
  assert.equal(hooks.statusFromGitHub({
    labels: ["📋 Grant Application draft", "👀 Ready For ZCG Review"],
    state: "open"
  } as never), "submitted");
});

test("terminal GitHub and Sheet decisions remain authoritative", () => {
  assert.equal(hooks.statusFromGitHub({
    labels: ["Changes Approved"],
    state: "closed"
  } as never), "closed");
  assert.equal(hooks.statusFromGitHub({
    labels: ["✅ Grant Approved"],
    state: "closed"
  } as never), "approved");
  assert.equal(hooks.statusFromGitHub({
    labels: ["❌ Grant Declined"],
    state: "closed"
  } as never), "declined");
  assert.equal(hooks.statusFromSheetWithoutOfficialAssignment("ZCG to discuss"), "submitted");
  assert.equal(hooks.statusFromSheetWithoutOfficialAssignment("Approved"), "approved");
});

test("records a warning when the Sheet claims review before official GitHub assignment", () => {
  const warning = hooks.sheetReviewAssignmentConflictIssue({
    sourceRecord: {
      id: "00000000-0000-4000-8000-000000000351"
    },
    title: "Grant Application - Example",
    displayTitle: "Example",
    labels: ["👀 Ready For ZCG Review"],
    issueNumber: 351,
    issueUrl: "https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues/351"
  } as never, "under_review", "ZCG to discuss");

  assert.equal(warning?.issueType, "sheet_review_without_official_github_assignment");
  assert.equal(warning?.severity, "warning");
  assert.deepEqual(warning?.details.missingGitHubLabelSlugs, ["grant_application"]);

  assert.equal(hooks.sheetReviewAssignmentConflictIssue({
    sourceRecord: { id: "00000000-0000-4000-8000-000000000351" },
    title: "Grant Application - Example",
    displayTitle: "Example",
    labels: ["📋 Grant Application", "👀 Ready For ZCG Review"]
  } as never, "under_review", "ZCG to discuss"), null);
});

test("Reference Flow fixture resolves stale Sheet review status to GitHub declined", () => {
  const githubStatus = hooks.statusFromGitHub({
    labels: ["Ready", "❌ Grant Declined"],
    state: "closed"
  } as never);
  const sheetStatus = hooks.statusFromSheet("ZCG to discuss");

  assert.equal(sheetStatus, "under_review");
  assert.equal(githubStatus, "declined");
  assert.equal(hooks.resolveCanonicalStatus(sheetStatus, githubStatus), "declined");
});

test("normalizes only unambiguous ISO and US calendar dates", () => {
  assert.equal(hooks.normalizedCalendarDate("2026-07-14"), "2026-07-14");
  assert.equal(hooks.normalizedCalendarDate("7/14/2026"), "2026-07-14");
  assert.equal(hooks.normalizedCalendarDate("2026-02-30"), null);
  assert.equal(hooks.normalizedCalendarDate("July 14, 2026"), null);
});

test("uses an official registry decision date as exact status evidence", () => {
  const github = {
    id: "00000000-0000-0000-0000-000000000011",
    source_kind: "github_issue",
    source_id: "ZcashCommunityGrants/zcashcommunitygrants#351",
    source_url: "https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues/351",
    checksum_sha256: "github-checksum",
    source_updated_at: "2026-07-14T12:00:00.000Z",
    raw_payload: JSON.stringify({ created_at: "2026-07-01T12:00:00.000Z" }),
    metadata: "{}",
    title: "Example",
    summary: null
  };
  const sheet = {
    ...github,
    id: "00000000-0000-0000-0000-000000000012",
    source_kind: "google_sheet_row",
    source_id: "sheet:1164534734:row:1",
    checksum_sha256: "sheet-checksum"
  };
  const evidence = hooks.statusEvidenceForPlannedApplication(
    {
      application: {
        canonicalKey: "github:ZcashCommunityGrants/zcashcommunitygrants#351",
        title: "Example",
        applicantName: "Example Applicant",
        githubIssueNumber: 351,
        githubIssueUrl: github.source_url,
        githubState: "closed",
        normalizedStatus: "approved",
        requestedAmountUsd: 10_000,
        matchConfidence: 1,
        sourceSummary: {
          githubLabels: ["Grant Approved"],
          historicalRegistryStatus: "Approved",
          historicalRegistryDecisionDate: "7/14/2026"
        }
      },
      links: [
        { sourceRecordId: github.id, confidence: 1 },
        { sourceRecordId: sheet.id, confidence: 1 }
      ],
      githubLabels: [],
      forumLinks: [],
      grant: null,
      issues: []
    } as never,
    new Map([
      [github.id, github],
      [sheet.id, sheet]
    ]) as never
  );

  assert.equal(evidence.provenance, "exact");
  assert.equal(evidence.effectiveDate, "2026-07-14");
  assert.equal(evidence.effectiveAt, null);
  assert.equal(evidence.sourceRecordId, sheet.id);
  assert.equal(evidence.sourceField, "Date Committee Approved/ Rejected");

  const conflicting = hooks.statusEvidenceForPlannedApplication(
    {
      application: {
        canonicalKey: "github:ZcashCommunityGrants/zcashcommunitygrants#351",
        title: "Example",
        applicantName: "Example Applicant",
        githubIssueNumber: 351,
        githubIssueUrl: github.source_url,
        githubState: "closed",
        normalizedStatus: "declined",
        requestedAmountUsd: 10_000,
        matchConfidence: 1,
        sourceSummary: {
          githubLabels: ["Grant Declined"],
          historicalRegistryStatus: "Approved",
          historicalRegistryDecisionDate: "7/14/2026"
        }
      },
      links: [
        { sourceRecordId: github.id, confidence: 1 },
        { sourceRecordId: sheet.id, confidence: 1 }
      ],
      githubLabels: [],
      forumLinks: [],
      grant: null,
      issues: []
    } as never,
    new Map([
      [github.id, github],
      [sheet.id, sheet]
    ]) as never
  );

  assert.equal(conflicting.provenance, "observed");
  assert.equal(conflicting.effectiveDate, null);
});

test("infers submission from GitHub creation without treating updates or closure as decisions", () => {
  const github = {
    id: "00000000-0000-0000-0000-000000000013",
    source_kind: "github_issue",
    source_id: "ZcashCommunityGrants/zcashcommunitygrants#352",
    source_url: "https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues/352",
    checksum_sha256: "github-checksum",
    source_updated_at: "2026-07-14T18:00:00.000Z",
    raw_payload: JSON.stringify({
      created_at: "2026-07-02T13:14:15.000Z",
      updated_at: "2026-07-14T18:00:00.000Z",
      closed_at: "2026-07-13T17:00:00.000Z"
    }),
    metadata: "{}",
    title: "Submitted example",
    summary: null
  };
  const evidence = hooks.statusEvidenceForPlannedApplication(
    {
      application: {
        canonicalKey: "github:ZcashCommunityGrants/zcashcommunitygrants#352",
        title: "Submitted example",
        applicantName: null,
        githubIssueNumber: 352,
        githubIssueUrl: github.source_url,
        githubState: "open",
        normalizedStatus: "submitted",
        requestedAmountUsd: null,
        matchConfidence: 1,
        sourceSummary: { githubLabels: [] }
      },
      links: [{ sourceRecordId: github.id, confidence: 1 }],
      githubLabels: [],
      forumLinks: [],
      grant: null,
      issues: []
    } as never,
    new Map([[github.id, github]]) as never
  );

  assert.equal(evidence.provenance, "inferred");
  assert.equal(evidence.effectiveAt, "2026-07-02T13:14:15.000Z");
  assert.equal(evidence.effectiveDate, null);
  assert.equal(evidence.sourceField, "created_at");
});

test("removes existing grant rows only for processed applications that are no longer funded", async () => {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const deleted = await hooks.deleteGrantsForUnfundedProcessedApplications(
    [
      { applicationId: "00000000-0000-0000-0000-000000000001", normalizedStatus: "approved" },
      { applicationId: "00000000-0000-0000-0000-000000000002", normalizedStatus: "active" },
      { applicationId: "00000000-0000-0000-0000-000000000003", normalizedStatus: "completed" },
      { applicationId: "00000000-0000-0000-0000-000000000004", normalizedStatus: "declined" },
      { applicationId: "00000000-0000-0000-0000-000000000005", normalizedStatus: "withdrawn" }
    ],
    async (text, values = []) => {
      calls.push({ text, values });
      return { rowCount: 2 };
    }
  );

  assert.equal(deleted, 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /delete from grants/);
  assert.deepEqual(JSON.parse(String(calls[0].values[0])), [
    { application_id: "00000000-0000-0000-0000-000000000004" },
    { application_id: "00000000-0000-0000-0000-000000000005" }
  ]);
});

test("does not touch existing grant rows when every processed application remains funded", async () => {
  let queryCalls = 0;
  const deleted = await hooks.deleteGrantsForUnfundedProcessedApplications(
    [
      { applicationId: "00000000-0000-0000-0000-000000000001", normalizedStatus: "approved" },
      { applicationId: "00000000-0000-0000-0000-000000000002", normalizedStatus: "active" },
      { applicationId: "00000000-0000-0000-0000-000000000003", normalizedStatus: "completed" }
    ],
    async () => {
      queryCalls += 1;
      return { rowCount: 0 };
    }
  );

  assert.equal(deleted, 0);
  assert.equal(queryCalls, 0);
});
