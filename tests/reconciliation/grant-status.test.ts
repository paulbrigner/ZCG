import assert from "node:assert/strict";
import test from "node:test";
import { grantReconciliationTestHooks as hooks } from "../../lib/reconciliation/grants";

test("an explicit GitHub decision supersedes only a provisional Sheet status", () => {
  assert.equal(hooks.resolveCanonicalStatus("under_review", "declined"), "declined");
  assert.equal(hooks.resolveCanonicalStatus("under_review", "approved"), "approved");
  assert.equal(hooks.resolveCanonicalStatus("under_review", "submitted"), "under_review");
  assert.equal(hooks.resolveCanonicalStatus("approved", "declined"), "approved");
  assert.equal(hooks.resolveCanonicalStatus("declined", "approved"), "declined");
  assert.equal(hooks.resolveCanonicalStatus("completed", "approved"), "completed");
  assert.equal(hooks.resolveCanonicalStatus("unknown", "declined"), "declined");
  assert.equal(hooks.resolveCanonicalStatus(null, "submitted"), "submitted");
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
