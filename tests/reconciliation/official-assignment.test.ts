import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalGitHubWorkflowLabel,
  hasOfficialZcgAssignmentLabels,
  isOfficialZcgCommitteeReview,
  missingOfficialZcgAssignmentLabels
} from "../../lib/grants/official-assignment";

test("canonicalizes decorated GitHub workflow labels", () => {
  assert.equal(canonicalGitHubWorkflowLabel("📋 Grant Application"), "grant_application");
  assert.equal(canonicalGitHubWorkflowLabel("👀 Ready For ZCG Review"), "ready_for_zcg_review");
});

test("recognizes an official assignment only when both exact labels are present", () => {
  const officialLabels = ["📋 Grant Application", "👀 Ready For ZCG Review", "KYC Required"];

  assert.equal(hasOfficialZcgAssignmentLabels(officialLabels), true);
  assert.equal(hasOfficialZcgAssignmentLabels(["👀 Ready For ZCG Review"]), false);
  assert.equal(hasOfficialZcgAssignmentLabels(["Grant Application draft", "Ready For ZCG Review"]), false);
  assert.deepEqual(missingOfficialZcgAssignmentLabels(["Grant Application"]), ["ready_for_zcg_review"]);
});

test("committee review eligibility also requires the canonical under-review status", () => {
  const labels = ["Grant Application", "Ready For ZCG Review"];

  assert.equal(isOfficialZcgCommitteeReview({ normalizedStatus: "under_review", labels }), true);
  assert.equal(isOfficialZcgCommitteeReview({ normalizedStatus: "approved", labels }), false);
  assert.equal(isOfficialZcgCommitteeReview({ normalizedStatus: "under_review", labels: ["Grant Application"] }), false);
});
