import assert from "node:assert/strict";
import test from "node:test";
import {
  googleSheetEvidenceBusinessIdentity,
  googleSheetRowNamespace,
  normalizeGoogleSheetEvidenceLocation,
  resolveGrantAnalysisEvidenceChanges,
  type CurrentGrantAnalysisEvidenceIdentity,
  type SavedGrantAnalysisEvidenceIdentity
} from "../../lib/knowledge/evidence-identity";

const applicationA = "00000000-0000-4000-8000-000000000001";
const applicationB = "00000000-0000-4000-8000-000000000002";
const sheetId = "sheet-one";
const milestoneGid = "803214474";
const allGrantsGid = "1164534734";

function sourceId(gid: string, row: number) {
  return `${sheetId}:${gid}:row:${row}`;
}

function sheetContent(gid: string, row: number, lines: readonly string[]) {
  return [
    "Grant application: Example grant",
    `Source: google_sheet_row:${sourceId(gid, row)}`,
    ...lines
  ].join("\n");
}

function savedEvidence(
  overrides: Partial<SavedGrantAnalysisEvidenceIdentity> = {}
): SavedGrantAnalysisEvidenceIdentity {
  const id = sourceId(milestoneGid, 765);
  return {
    documentKey: "saved-document",
    contentHash: "saved-hash",
    applicationId: applicationA,
    sourceKind: "google_sheet_row",
    sourceId: id,
    title: "Example grant",
    contentSnapshot: sheetContent(milestoneGid, 765, [
      "Project: Example grant",
      "Grantee: Example grantee",
      "Milestone: Final report",
      "Amount (USD): 25000",
      "Paid Out: 25 May 2026"
    ]),
    currentDocumentKey: null,
    currentContentHash: null,
    ...overrides
  };
}

function currentEvidence(
  overrides: Partial<CurrentGrantAnalysisEvidenceIdentity> = {}
): CurrentGrantAnalysisEvidenceIdentity {
  return {
    documentKey: "current-document",
    contentHash: "current-hash",
    applicationId: applicationA,
    sourceKind: "google_sheet_row",
    sourceId: sourceId(milestoneGid, 766),
    title: "Example grant",
    content: sheetContent(milestoneGid, 766, [
      "Project: Example grant",
      "Grantee: Example grantee",
      "Milestone: Final report",
      "Amount (USD): 25000",
      "Paid Out: 25 May 2026"
    ]),
    ...overrides
  };
}

test("Sheet namespace and content normalization remove only the row location", () => {
  const id = sourceId(milestoneGid, 765);
  const content = sheetContent(milestoneGid, 765, [
    "Milestone: Row 765 validation",
    "Amount (USD): 765",
    "Grant Platform Link: https://github.com/example/issues/765"
  ]);
  const normalized = normalizeGoogleSheetEvidenceLocation(content, id);

  assert.equal(googleSheetRowNamespace(id), `${sheetId}:${milestoneGid}`);
  assert.equal(googleSheetRowNamespace(`${sheetId}:${milestoneGid}`), null);
  assert.match(normalized ?? "", /Source: google_sheet_row:sheet-one:803214474:row:\*/);
  assert.match(normalized ?? "", /Milestone: Row 765 validation/);
  assert.match(normalized ?? "", /Amount \(USD\): 765/);
  assert.match(normalized ?? "", /issues\/765/);
});

test("an unchanged Sheet row move remains current", () => {
  assert.deepEqual(
    resolveGrantAnalysisEvidenceChanges([savedEvidence()], [currentEvidence()]),
    ["current"]
  );
});

test("a moved row with a material payment update is changed by stable business identity", () => {
  const current = currentEvidence({
    content: sheetContent(milestoneGid, 766, [
      "Project: Example grant",
      "Grantee: Example grantee",
      "Milestone: Final report",
      "Amount (USD): 25000",
      "Paid Out: 9 Jul 2026",
      "ZEC Disbursed: 6.4",
      "ZEC/USD: 468.75"
    ])
  });

  assert.deepEqual(resolveGrantAnalysisEvidenceChanges([savedEvidence()], [current]), ["changed"]);
  assert.equal(
    googleSheetEvidenceBusinessIdentity({
      sourceId: current.sourceId,
      title: current.title,
      content: current.content
    }),
    `${sheetId}:${milestoneGid}|milestone|example grant|example grantee|final report`
  );
});

test("milestone identity takes precedence when milestones share one grant link", () => {
  const sharedLink = "https://github.com/example/issues/123";
  const saved = savedEvidence({
    contentSnapshot: sheetContent(milestoneGid, 765, [
      "Project: Example grant",
      "Grantee: Example grantee",
      "Milestone: Final report",
      `Grant Platform Link: ${sharedLink}`,
      "Amount (USD): 25000"
    ])
  });
  const changedFinalReport = currentEvidence({
    documentKey: "current-final-report",
    content: sheetContent(milestoneGid, 766, [
      "Project: Example grant",
      "Grantee: Example grantee",
      "Milestone: Final report",
      `Grant Platform Link: ${sharedLink}`,
      "Amount (USD): 26000"
    ])
  });
  const otherMilestone = currentEvidence({
    documentKey: "current-startup",
    sourceId: sourceId(milestoneGid, 767),
    content: sheetContent(milestoneGid, 767, [
      "Project: Example grant",
      "Grantee: Example grantee",
      "Milestone: Startup funding",
      `Grant Platform Link: ${sharedLink}`,
      "Amount (USD): 5000"
    ])
  });

  assert.deepEqual(
    resolveGrantAnalysisEvidenceChanges([saved], [changedFinalReport, otherMilestone]),
    ["changed"]
  );
});

test("same content in another application or Sheet tab cannot rescue evidence", () => {
  const saved = savedEvidence();
  const otherApplication = currentEvidence({ applicationId: applicationB });
  const otherTab = currentEvidence({
    sourceId: sourceId(allGrantsGid, 766),
    content: sheetContent(allGrantsGid, 766, [
      "Project: Example grant",
      "Grantee: Example grantee",
      "Milestone: Final report",
      "Amount (USD): 25000",
      "Paid Out: 25 May 2026"
    ])
  });

  assert.deepEqual(resolveGrantAnalysisEvidenceChanges([saved], [otherApplication]), ["missing"]);
  assert.deepEqual(resolveGrantAnalysisEvidenceChanges([saved], [otherTab]), ["missing"]);
});

test("Sheet matching finds moved content when the old coordinate now contains a neighbor", () => {
  const saved = savedEvidence({
    currentDocumentKey: "saved-document",
    currentContentHash: "neighbor-hash"
  });
  const neighbor = currentEvidence({
    documentKey: "saved-document",
    contentHash: "neighbor-hash",
    sourceId: sourceId(milestoneGid, 765),
    content: sheetContent(milestoneGid, 765, [
      "Project: Neighbor grant",
      "Grantee: Someone else",
      "Milestone: Startup funding"
    ])
  });

  assert.deepEqual(
    resolveGrantAnalysisEvidenceChanges([saved], [neighbor, currentEvidence()]),
    ["current"]
  );
});

test("duplicate Sheet rows are matched as a multiset", () => {
  const firstSaved = savedEvidence({ documentKey: "saved-one" });
  const secondSaved = savedEvidence({ documentKey: "saved-two" });
  const firstCurrent = currentEvidence({ documentKey: "current-one" });
  const secondCurrent = currentEvidence({
    documentKey: "current-two",
    sourceId: sourceId(milestoneGid, 767),
    content: sheetContent(milestoneGid, 767, [
      "Project: Example grant",
      "Grantee: Example grantee",
      "Milestone: Final report",
      "Amount (USD): 25000",
      "Paid Out: 25 May 2026"
    ])
  });

  assert.deepEqual(
    resolveGrantAnalysisEvidenceChanges([firstSaved, secondSaved], [firstCurrent, secondCurrent]),
    ["current", "current"]
  );
  assert.deepEqual(
    resolveGrantAnalysisEvidenceChanges([firstSaved, secondSaved], [firstCurrent]),
    ["current", "missing"]
  );
  assert.deepEqual(
    resolveGrantAnalysisEvidenceChanges([firstSaved], [firstCurrent, secondCurrent]),
    ["current"]
  );
});

test("ambiguous changed duplicate rows are never selected arbitrarily", () => {
  const firstSaved = savedEvidence({ documentKey: "saved-one" });
  const secondSaved = savedEvidence({ documentKey: "saved-two" });
  const changedLines = [
    "Project: Example grant",
    "Grantee: Example grantee",
    "Milestone: Final report",
    "Amount (USD): 26000"
  ];
  const firstCurrent = currentEvidence({
    documentKey: "current-one",
    content: sheetContent(milestoneGid, 766, changedLines)
  });
  const secondCurrent = currentEvidence({
    documentKey: "current-two",
    sourceId: sourceId(milestoneGid, 767),
    content: sheetContent(milestoneGid, 767, changedLines)
  });

  assert.deepEqual(
    resolveGrantAnalysisEvidenceChanges([firstSaved, secondSaved], [firstCurrent, secondCurrent]),
    ["missing", "missing"]
  );
});

test("an unrelated replacement in the same application and tab remains missing", () => {
  const saved = savedEvidence({
    contentSnapshot: sheetContent(milestoneGid, 765, ["Description: Deleted evidence"])
  });
  const replacement = currentEvidence({
    content: sheetContent(milestoneGid, 766, ["Description: Newly added unrelated evidence"])
  });

  assert.deepEqual(resolveGrantAnalysisEvidenceChanges([saved], [replacement]), ["missing"]);
});

test("non-Sheet and malformed Sheet evidence retain exact-key hash semantics", () => {
  const nonSheet = savedEvidence({
    sourceKind: "github_issue",
    sourceId: "example/issues/1",
    currentDocumentKey: "saved-document",
    currentContentHash: "changed-hash"
  });
  const malformedSheet = savedEvidence({
    sourceId: "sheet-without-a-row",
    currentDocumentKey: "saved-document",
    currentContentHash: "changed-hash"
  });

  assert.deepEqual(resolveGrantAnalysisEvidenceChanges([nonSheet], []), ["changed"]);
  assert.deepEqual(resolveGrantAnalysisEvidenceChanges([malformedSheet], []), ["changed"]);
});
