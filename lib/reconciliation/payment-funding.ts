export type FundingMilestone = {
  sourceRecordId: string;
  milestoneLabel: string;
  amountUsd: number | null;
};

export function summarizeLedgerFunding(rows: FundingMilestone[], unresolvedOwnership = false) {
  const unique = [...new Map(rows.map((row) => [row.sourceRecordId, row])).values()];
  let scheduledCents = 0;
  let adjustmentCents = 0;
  let reimbursementCents = 0;
  let scheduleRows = 0;
  let missingAmounts = 0;
  let uncertainAdjustment = false;
  for (const row of unique) {
    const returned = /\b(return(?:ed)?|refund(?:ed)?|tips)\b/iu.test(row.milestoneLabel);
    const reimbursement = /\breimburse/iu.test(row.milestoneLabel);
    if (row.amountUsd === null) {
      missingAmounts++;
      continue;
    }
    const cents = Math.round(row.amountUsd * 100);
    if (returned || cents < 0) {
      adjustmentCents += cents;
      // A negative ordinary milestone may be a correction, not a separate refund.
      if (cents < 0 && !returned) uncertainAdjustment = true;
    } else if (reimbursement) {
      reimbursementCents += cents;
    } else {
      scheduledCents += cents;
      scheduleRows++;
    }
  }
  const complete = scheduleRows > 0 && missingAmounts === 0 && !unresolvedOwnership && !uncertainAdjustment;
  return {
    basis: "Owned payment-ledger schedule; may cover only part of the requested grant. Not USD disbursed.",
    scheduleAmountUsd: scheduleRows ? scheduledCents / 100 : null,
    confirmedScheduleAmountUsd: complete ? scheduledCents / 100 : null,
    adjustmentAmountUsd: adjustmentCents / 100,
    reimbursementAmountUsd: reimbursementCents / 100,
    rowCount: unique.length,
    missingAmounts,
    unresolvedOwnership,
    uncertainAdjustment,
    status: complete ? "complete" : "unconfirmed"
  };
}
