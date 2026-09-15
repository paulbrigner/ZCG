import assert from "node:assert/strict";
import test from "node:test";
import { summarizeLedgerFunding } from "../../lib/reconciliation/payment-funding";
import { compatiblePaymentTitles } from "../../lib/reconciliation/payment-identity";
import { milestoneProjectionTestHooks as hooks } from "../../lib/reconciliation/milestones";

const schedule = (amounts: Array<number | null>) => amounts.map((amountUsd, i) => ({
  sourceRecordId: `row-${i}`, milestoneLabel: String(i + 1), amountUsd
}));

test("totals installments without substituting the requested amount or largest row", () => {
  assert.equal(summarizeLedgerFunding(schedule([7000, 4000, 4000, 4000, 4000, 4000])).confirmedScheduleAmountUsd, 27000);
  assert.equal(summarizeLedgerFunding(schedule([3000, 3000, 3000])).confirmedScheduleAmountUsd, 9000);
  assert.equal(summarizeLedgerFunding(schedule([4000])).confirmedScheduleAmountUsd, 4000, "Arabia milestone 1 only, not its $20k request");
  assert.equal(summarizeLedgerFunding(schedule([45833, 45833, 45833, 45833, 45833, 45833, 45833, 45833, 45833, 49000])).confirmedScheduleAmountUsd, 461497, "ZECsy through M9 only, not its $550k request");
  assert.equal(summarizeLedgerFunding(schedule([0, 0])).confirmedScheduleAmountUsd, 0);
  assert.equal(summarizeLedgerFunding(schedule([0.1, 0.2])).confirmedScheduleAmountUsd, 0.3);
});

test("keeps unknown amounts, refunds and reimbursements distinct from the schedule", () => {
  assert.equal(summarizeLedgerFunding(schedule([100, null])).confirmedScheduleAmountUsd, null);
  assert.equal(summarizeLedgerFunding(schedule([100]), true).confirmedScheduleAmountUsd, null);
  const rows = [...schedule([100]),
    { sourceRecordId: "refund", milestoneLabel: "Funds Returned", amountUsd: -20 },
    { sourceRecordId: "reimbursement", milestoneLabel: "Event Reimbursement", amountUsd: 10 }];
  const total = summarizeLedgerFunding(rows);
  assert.equal(total.confirmedScheduleAmountUsd, 100);
  assert.equal(total.adjustmentAmountUsd, -20);
  assert.equal(total.reimbursementAmountUsd, 10);
  assert.equal(summarizeLedgerFunding(schedule([6121, -2394.99])).confirmedScheduleAmountUsd, null);
});

test("deduplicates source identity but preserves legitimate repeated labels and split payments", () => {
  const one = { sourceRecordId: "one", milestoneLabel: "Startup Funding", amountUsd: 450000 };
  const two = { ...one, sourceRecordId: "two" };
  assert.equal(summarizeLedgerFunding([one, one, two]).confirmedScheduleAmountUsd, 900000);
  assert.equal(summarizeLedgerFunding([{ ...one, milestoneLabel: "5a" }, { ...two, milestoneLabel: "5b" }]).confirmedScheduleAmountUsd, 900000);
});

function candidate(id: string, status: string, options: Record<string, unknown> = {}) {
  return hooks.sourceRowFromQuery({
    application_id: id, application_key: id, application_title: "Arabia", application_status: status,
    source_record_id: "source", source_id: "sheet:767", match_confidence: "1", manually_linked: false,
    raw_payload: { Project: "Arabia", Milestone: "1", "Amount (USD)": 4000 }, ...options
  });
}

test("rejected resubmissions cannot own an approved grant's installments", () => {
  const approved = candidate("approved", "approved");
  const rejected = candidate("rejected", "declined");
  assert.deepEqual(hooks.selectMilestoneSources([rejected, approved]).selected.map(r => r.applicationId), ["approved"]);
  assert.equal(hooks.selectMilestoneSources([rejected]).selected.length, 0);
  assert.equal(hooks.selectMilestoneSources([approved, candidate("second", "active")]).ambiguous.length, 1);
});

test("manual ownership overrides automatic evidence, but conflicting manual owners stay ambiguous", () => {
  const manual = candidate("manual", "declined", { manually_linked: true });
  const automatic = candidate("auto", "approved");
  assert.equal(hooks.selectMilestoneSources([manual, automatic]).selected[0].applicationId, "manual");
  assert.equal(hooks.selectMilestoneSources([manual, { ...automatic, manuallyLinked: true }]).ambiguous.length, 1);
});

test("phase, revision, year and quarter markers survive fuzzy title comparison", () => {
  assert.equal(compatiblePaymentTitles("ZURE Phase 2", "ZURE Phase 1"), false);
  assert.equal(compatiblePaymentTitles("Zcash Global en Español Q3", "Zcash Global en Español Q4"), false);
  assert.equal(compatiblePaymentTitles("Brazil 2025", "Brazil 2026"), false);
  assert.equal(compatiblePaymentTitles("ZECsy", "ZECsy Revised"), false);
  assert.equal(compatiblePaymentTitles("ZECsy (Revised)", "ZECsy Revised"), true);
  assert.equal(compatiblePaymentTitles("Zcash Global en Español", "Zcash Global en Español Q4"), true);
});

test("an inconsistent payment date does not discard a uniquely matched ledger installment", () => {
  const paid = { Project: "Arabia", Milestone: "1", "Paid Out": "5/1/2026" };
  assert.equal(hooks.selectMilestoneSources([candidate("later", "approved", { raw_payload: paid, submitted_date: "5/21/2026" })]).selected.length, 1);
  assert.equal(hooks.selectMilestoneSources([candidate("unknown", "approved", { raw_payload: paid })]).selected.length, 1);
});

test("targeted reassignments recompute complete schedules for old and new owners and index both", async () => {
  const oldId = "00000000-0000-4000-8000-000000000001";
  const newId = "00000000-0000-4000-8000-000000000002";
  let funding: Array<{ application_id: string; approved_amount_usd: number | null }> = [];
  const sync = hooks.createSyncGrantMilestoneProjections(async (sql, values = []) => {
    if (sql.includes("grant_milestone_application_scope")) {
      assert.match(sql, /union select application_id, source_record_id from grant_milestones/);
      return { rows: [{ application_id: oldId }, { application_id: newId }] };
    }
    if (sql.includes("grant_milestone_projection_sources")) {
      assert.deepEqual(JSON.parse(String(values[0])), [oldId, newId]);
      return { rows: [] };
    }
    if (sql.includes("delete_stale")) {
      assert.deepEqual(JSON.parse(String(values[0])), [oldId, newId]);
      return { rowCount: 0 };
    }
    if (sql.includes("grant_funding_projection_sources")) {
      assert.deepEqual(JSON.parse(String(values[0])), [oldId, newId]);
      return { rows: [
        { application_id: oldId, candidate_count: 1, milestones: "[]" },
        { application_id: newId, candidate_count: 2, milestones: JSON.stringify(schedule([3000, 3000])) }
      ] };
    }
    if (sql.includes("grant_funding_projection_upsert")) {
      funding = JSON.parse(String(values[0]));
      return { rowCount: 2 };
    }
    if (sql.includes("grant_milestone_ambiguity_issues_resolve")) return { rowCount: 0 };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const result = await sync({ applicationIds: [oldId] });
  assert.deepEqual(result.affectedApplicationIds, [oldId, newId]);
  assert.equal(funding.find(r => r.application_id === oldId)?.approved_amount_usd, null);
  assert.equal(funding.find(r => r.application_id === newId)?.approved_amount_usd, 6000);
});
