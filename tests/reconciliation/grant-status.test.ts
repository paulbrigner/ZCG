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
