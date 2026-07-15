import assert from "node:assert/strict";
import test from "node:test";
import {
  milestoneProjectionTestHooks as hooks,
  parseGrantMilestoneSheetRow,
  parseSheetDate,
  parseSheetMoney,
  parseSheetNumber
} from "../../lib/reconciliation/milestones";

test("parses milestone rows with whitespace-insensitive Sheet headers", () => {
  const parsed = parseGrantMilestoneSheetRow({
    Project: "Example grant",
    Grantee: "Example grantee",
    " CATEGORY \n(AS DETERMINED BY ZCG) ": "Infrastructure",
    "Reporting Frequency \n(as determined by ZCG)": "Monthly",
    Milestone: " 1 ",
    "Amount (USD)": "$10,000.50",
    Estimate: "Oct 4, 2021",
    "Paid Out": "4 Oct 2021",
    "ZEC Disbursed": "123.456",
    "USD Disbursed": "",
    "ZEC/USD": "$86.04",
    "Grant Status": "Active"
  });

  assert.ok(parsed);
  assert.equal(parsed.project, "Example grant");
  assert.equal(parsed.granteeName, "Example grantee");
  assert.equal(parsed.category, "Infrastructure");
  assert.equal(parsed.reportingFrequency, "Monthly");
  assert.equal(parsed.milestoneLabel, "1");
  assert.equal(parsed.milestoneNumber, 1);
  assert.equal(parsed.milestoneType, "numbered");
  assert.equal(parsed.amountUsd, 10_000.5);
  assert.equal(parsed.estimateText, "Oct 4, 2021");
  assert.equal(parsed.estimatedAt, "2021-10-04");
  assert.equal(parsed.paidAt, "2021-10-04");
  assert.equal(parsed.zecAmount, 123.456);
  assert.equal(parsed.usdAmount, null, "milestone amount must not become USD disbursed");
  assert.equal(parsed.exchangeRateUsdPerZec, 86.04);
  assert.equal(parsed.grantStatus, "Active");
});

test("strictly parses common Sheet numbers, money, and dates", () => {
  assert.equal(parseSheetNumber("1,234.50"), 1234.5);
  assert.equal(parseSheetNumber("12,34.50"), null);
  assert.equal(parseSheetNumber("1e3"), null);
  assert.equal(parseSheetMoney("-$23,520.00"), -23_520);
  assert.equal(parseSheetMoney("($1,000.25)"), -1000.25);
  assert.equal(parseSheetMoney("USD 86.04"), null);
  assert.equal(parseSheetDate("2026-07-15"), "2026-07-15");
  assert.equal(parseSheetDate("15 Jul 2026"), "2026-07-15");
  assert.equal(parseSheetDate("Oct 4, 2021"), "2021-10-04");
  assert.equal(parseSheetDate("7/15/2026"), "2026-07-15");
  assert.equal(parseSheetDate("2026-02-30"), null);
  assert.equal(parseSheetDate("15/7/2026"), null);
});

test("retains relative estimates and classifies noninteger milestone labels", () => {
  const labels = [
    ["Start up funding", "startup_funding"],
    ["Startup Funding", "startup_funding"],
    ["START-UP FUNDING", "startup_funding"],
    ["Start Up", "startup_funding"],
    ["Start Up Funding: Payout 1", "startup_funding"],
    ["Startup Funding: Conferences", "startup_funding"],
    ["Start Up Funding #1", "startup_funding"],
    ["Funds Returned", "named"],
    ["5a", "named"],
    ["2-3", "named"],
    ["1.5", "named"]
  ] as const;

  for (const [label, expectedType] of labels) {
    const parsed = parseGrantMilestoneSheetRow({
      Milestone: label,
      Estimate: "2 months after merge"
    });

    assert.ok(parsed);
    assert.equal(parsed.milestoneType, expectedType);
    assert.equal(parsed.milestoneNumber, null);
    assert.equal(parsed.estimateText, "2 months after merge");
    assert.equal(parsed.estimatedAt, null);
  }

  assert.equal(parseGrantMilestoneSheetRow({ Project: "No milestone" }), null);
});

test("syncs reviewed and high-confidence projections and deletes stale rows in scope", async () => {
  const applicationOne = "00000000-0000-4000-8000-000000000001";
  const applicationTwo = "00000000-0000-4000-8000-000000000002";
  const sourceOne = "10000000-0000-4000-8000-000000000001";
  const sourceTwo = "10000000-0000-4000-8000-000000000002";
  const sourceSkipped = "10000000-0000-4000-8000-000000000003";
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  let milestonePayload: Array<Record<string, unknown>> = [];
  let disbursementPayload: Array<Record<string, unknown>> = [];

  const sync = hooks.createSyncGrantMilestoneProjections(async (text, values = []) => {
    calls.push({ text, values });

    if (text.includes("grant_milestone_projection_sources")) {
      return {
        rows: [
          {
            application_id: applicationOne,
            application_key: "github:owner/repo#1",
            application_title: "Reviewed link grant",
            source_record_id: sourceOne,
            source_id: "sheet-one:803214474:row:7",
            source_url: "https://docs.google.com/spreadsheets/d/sheet-one/edit?gid=803214474",
            raw_payload: JSON.stringify({
              Project: "Reviewed link grant",
              Grantee: "Alice",
              Milestone: "Startup Funding",
              "Amount (USD)": "$5,000",
              "Paid Out": "Oct 4, 2021",
              "ZEC Disbursed": "50",
              "ZEC/USD": "$100"
            }),
            metadata: JSON.stringify({
              sheetId: "sheet-one",
              gid: "803214474",
              tabName: "milestone_details",
              rowNumber: 7
            }),
            match_confidence: "0.5000",
            manually_linked: true
          },
          {
            application_id: applicationTwo,
            application_key: "github:owner/repo#2",
            application_title: "Similarity grant",
            source_record_id: sourceTwo,
            source_id: "sheet-one:803214474:row:8",
            source_url: "https://docs.google.com/spreadsheets/d/sheet-one/edit?gid=803214474",
            raw_payload: JSON.stringify({
              Project: "Similarity grant",
              Milestone: "5a",
              "Amount (USD)": "$8,000"
            }),
            metadata: JSON.stringify({
              sheetId: "sheet-one",
              gid: "803214474",
              tabName: "milestone_details",
              rowNumber: 8
            }),
            match_confidence: "0.9500",
            manually_linked: false
          },
          {
            application_id: applicationTwo,
            application_key: "github:owner/repo#2",
            application_title: "Similarity grant",
            source_record_id: sourceSkipped,
            source_id: "sheet-one:803214474:row:9",
            source_url: null,
            raw_payload: JSON.stringify({ Project: "Header-only row" }),
            metadata: JSON.stringify({ tabName: "milestone_details", rowNumber: 9 }),
            match_confidence: "1.0000",
            manually_linked: false
          }
        ]
      };
    }

    if (text.includes("grant_milestones_upsert")) {
      milestonePayload = JSON.parse(String(values[0])) as Array<Record<string, unknown>>;
      return {
        rows: milestonePayload.map((row, index) => ({
          id: `20000000-0000-4000-8000-00000000000${index + 1}`,
          source_record_id: row.source_record_id
        }))
      };
    }

    if (text.includes("grant_milestone_ambiguity_issues_resolve")) {
      return { rowCount: 0 };
    }

    if (text.includes("grant_disbursements_upsert")) {
      disbursementPayload = JSON.parse(String(values[0])) as Array<Record<string, unknown>>;
      return { rowCount: disbursementPayload.length };
    }

    if (text.includes("grant_disbursements_delete_stale")) {
      return { rowCount: 1 };
    }

    if (text.includes("grant_milestones_delete_stale")) {
      return { rowCount: 2 };
    }

    throw new Error(`Unexpected query: ${text}`);
  });

  const result = await sync({ applicationIds: [applicationOne, applicationTwo] });

  assert.deepEqual(result, {
    ok: true,
    sourceRowsSeen: 3,
    sourceRowsSkipped: 1,
    milestonesUpserted: 2,
    disbursementsUpserted: 1,
    milestonesDeleted: 2,
    disbursementsDeleted: 1,
    ambiguousSourceLinks: 0
  });
  assert.match(calls[0].text, /match_confidence >= 0\.92/);
  assert.match(calls[0].text, /rd\.decision_type = \$2/);
  assert.equal(calls[0].values[1], "link_source");
  assert.match(calls[0].text, /join grant_applications reviewed_application/);
  assert.deepEqual(JSON.parse(String(calls[0].values[0])), [applicationOne, applicationTwo]);

  assert.equal(milestonePayload[0].linkage_method, "reviewer_confirmed");
  assert.equal(milestonePayload[1].linkage_method, "similarity");
  assert.equal(
    milestonePayload[0].source_url,
    "https://docs.google.com/spreadsheets/d/sheet-one/edit?gid=803214474#gid=803214474&range=A7:L7"
  );
  assert.equal(disbursementPayload.length, 1);
  assert.equal(disbursementPayload[0].usd_amount, null);
  assert.equal(disbursementPayload[0].zec_amount, 50);
  assert.equal(disbursementPayload[0].exchange_rate_usd_per_zec, 100);

  const disbursementDelete = calls.find((call) =>
    call.text.includes("grant_disbursements_delete_stale")
  );
  const milestoneDelete = calls.find((call) =>
    call.text.includes("grant_milestones_delete_stale")
  );
  assert.deepEqual(JSON.parse(String(disbursementDelete?.values[1])), [sourceOne]);
  assert.deepEqual(JSON.parse(String(milestoneDelete?.values[1])), [sourceOne, sourceTwo]);
});

test("quarantines duplicate exact links and maintains one ambiguity issue", async () => {
  const applicationOne = "00000000-0000-4000-8000-000000000011";
  const applicationTwo = "00000000-0000-4000-8000-000000000012";
  const sourceRecordId = "10000000-0000-4000-8000-000000000767";
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  let issuePayload: Array<{
    source_record_id: string;
    summary: string;
    details: {
      generatedBy: string;
      candidateApplicationIds: string[];
      candidates: Array<{ canonicalKey: string; confidence: number }>;
    };
  }> = [];

  const row = {
    source_record_id: sourceRecordId,
    source_id: "sheet-one:803214474:row:767",
    source_url: "https://docs.google.com/spreadsheets/d/sheet-one/edit?gid=803214474",
    raw_payload: JSON.stringify({
      Project: "Ambiguous grant",
      Milestone: "2",
      "Amount (USD)": "$2,000"
    }),
    metadata: JSON.stringify({
      sheetId: "sheet-one",
      gid: "803214474",
      tabName: "milestone_details",
      rowNumber: 767
    }),
    match_confidence: "1.0000",
    manually_linked: false
  };
  const sync = hooks.createSyncGrantMilestoneProjections(async (text, values = []) => {
    calls.push({ text, values });

    if (text.includes("grant_milestone_projection_sources")) {
      return {
        rows: [
          {
            ...row,
            application_id: applicationOne,
            application_key: "github:ZcashCommunityGrants/zcashcommunitygrants#289",
            application_title: "Grant #289"
          },
          {
            ...row,
            application_id: applicationTwo,
            application_key: "github:ZcashCommunityGrants/zcashcommunitygrants#301",
            application_title: "Grant #301"
          }
        ]
      };
    }

    if (text.includes("grant_milestone_ambiguity_issues_upsert")) {
      issuePayload = JSON.parse(String(values[0])) as typeof issuePayload;
      return { rowCount: 1 };
    }

    if (text.includes("grant_milestone_ambiguity_issues_resolve")) {
      return { rowCount: 0 };
    }

    if (text.includes("grant_disbursements_delete_stale")) {
      return { rowCount: 1 };
    }

    if (text.includes("grant_milestones_delete_stale")) {
      return { rowCount: 1 };
    }

    throw new Error(`Unexpected query: ${text}`);
  });

  const result = await sync({ applicationIds: [applicationOne] });

  assert.equal(result.ambiguousSourceLinks, 1);
  assert.equal(result.milestonesUpserted, 0);
  assert.equal(result.sourceRowsSeen, 2);
  assert.equal(result.sourceRowsSkipped, 2);
  assert.equal(calls.some((call) => call.text.includes("grant_milestones_upsert")), false);
  assert.match(calls[0].text, /scoped_candidate\.source_record_id = candidate\.source_record_id/);
  assert.equal(issuePayload.length, 1);
  assert.equal(issuePayload[0].source_record_id, sourceRecordId);
  assert.match(issuePayload[0].summary, /Ambiguous grant \(Sheet row 767\)/);
  assert.equal(issuePayload[0].details.generatedBy, "grant_milestone_projection_v1");
  assert.deepEqual(issuePayload[0].details.candidateApplicationIds, [
    applicationOne,
    applicationTwo
  ]);
  assert.deepEqual(
    issuePayload[0].details.candidates.map((candidate) => candidate.canonicalKey),
    [
      "github:ZcashCommunityGrants/zcashcommunitygrants#289",
      "github:ZcashCommunityGrants/zcashcommunitygrants#301"
    ]
  );

  const issueUpsert = calls.find((call) =>
    call.text.includes("grant_milestone_ambiguity_issues_upsert")
  );
  assert.match(issueUpsert?.text ?? "", /issue\.status in \('open', 'assigned'\)/);
  assert.match(issueUpsert?.text ?? "", /autoResolvedBy/);
  assert.match(issueUpsert?.text ?? "", /where not exists/);

  const issueResolve = calls.find((call) =>
    call.text.includes("grant_milestone_ambiguity_issues_resolve")
  );
  assert.deepEqual(JSON.parse(String(issueResolve?.values[0])), [applicationOne]);
  assert.deepEqual(JSON.parse(String(issueResolve?.values[1])), [sourceRecordId]);
  assert.deepEqual(JSON.parse(String(issueResolve?.values[3])), [sourceRecordId]);
  assert.match(issueResolve?.text ?? "", /evaluated\.source_record_id::uuid = issue\.source_record_id/);

  const milestoneDelete = calls.find((call) =>
    call.text.includes("grant_milestones_delete_stale")
  );
  assert.deepEqual(JSON.parse(String(milestoneDelete?.values[0])), [applicationOne]);
  assert.deepEqual(JSON.parse(String(milestoneDelete?.values[2])), [sourceRecordId]);
});

test("a single reviewed link wins an otherwise duplicate source", async () => {
  const reviewedApplication = "00000000-0000-4000-8000-000000000021";
  const inferredApplication = "00000000-0000-4000-8000-000000000022";
  const exactApplication = "00000000-0000-4000-8000-000000000023";
  const reviewedSource = "10000000-0000-4000-8000-000000000021";
  const exactSource = "10000000-0000-4000-8000-000000000023";
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  let milestonePayload: Array<Record<string, unknown>> = [];

  const baseRow = {
    source_id: "sheet-one:803214474:row:21",
    source_url: null,
    raw_payload: JSON.stringify({ Project: "Reviewed winner", Milestone: "1" }),
    metadata: JSON.stringify({ tabName: "milestone_details", rowNumber: 21 })
  };
  const sync = hooks.createSyncGrantMilestoneProjections(async (text, values = []) => {
    calls.push({ text, values });

    if (text.includes("grant_milestone_projection_sources")) {
      return {
        rows: [
          {
            ...baseRow,
            application_id: reviewedApplication,
            application_key: "github:owner/repo#21",
            application_title: "Reviewed application",
            source_record_id: reviewedSource,
            match_confidence: "0.5000",
            manually_linked: true
          },
          {
            ...baseRow,
            application_id: inferredApplication,
            application_key: "github:owner/repo#22",
            application_title: "Inferred application",
            source_record_id: reviewedSource,
            match_confidence: "1.0000",
            manually_linked: false
          },
          {
            ...baseRow,
            application_id: exactApplication,
            application_key: "github:owner/repo#23",
            application_title: "Exact application",
            source_record_id: exactSource,
            source_id: "sheet-one:803214474:row:23",
            match_confidence: "1.0000",
            manually_linked: false
          }
        ]
      };
    }

    if (text.includes("grant_milestone_ambiguity_issues_resolve")) {
      return { rowCount: 1 };
    }

    if (text.includes("grant_milestones_upsert")) {
      milestonePayload = JSON.parse(String(values[0])) as Array<Record<string, unknown>>;
      return {
        rows: milestonePayload.map((payload, index) => ({
          id: `20000000-0000-4000-8000-00000000002${index + 1}`,
          source_record_id: payload.source_record_id
        }))
      };
    }

    if (text.includes("grant_disbursements_delete_stale")) {
      return { rowCount: 0 };
    }

    if (text.includes("grant_milestones_delete_stale")) {
      return { rowCount: 0 };
    }

    throw new Error(`Unexpected query: ${text}`);
  });

  const result = await sync({ applicationIds: [reviewedApplication, exactApplication] });

  assert.equal(result.ambiguousSourceLinks, 0);
  assert.equal(result.milestonesUpserted, 2);
  assert.equal(
    calls.some((call) => call.text.includes("grant_milestone_ambiguity_issues_upsert")),
    false
  );
  const reviewedProjection = milestonePayload.find(
    (payload) => payload.source_record_id === reviewedSource
  );
  const exactProjection = milestonePayload.find(
    (payload) => payload.source_record_id === exactSource
  );
  assert.equal(reviewedProjection?.application_id, reviewedApplication);
  assert.equal(reviewedProjection?.linkage_method, "reviewer_confirmed");
  assert.equal(exactProjection?.linkage_method, "exact");
});

test("an explicitly empty application scope is a no-op", async () => {
  let queryCalls = 0;
  const sync = hooks.createSyncGrantMilestoneProjections(async () => {
    queryCalls += 1;
    return {};
  });

  const result = await sync({ applicationIds: [] });

  assert.equal(queryCalls, 0);
  assert.deepEqual(result, {
    ok: true,
    sourceRowsSeen: 0,
    sourceRowsSkipped: 0,
    milestonesUpserted: 0,
    disbursementsUpserted: 0,
    milestonesDeleted: 0,
    disbursementsDeleted: 0,
    ambiguousSourceLinks: 0
  });
});
