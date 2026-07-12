import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMITTEE_BRIEFING_TEMPLATE_KEY,
  COMMITTEE_BRIEFING_TEMPLATE_VERSION,
  assembleGrantBriefingEvidence,
  formatGrantBriefingEvidenceForPrompt,
  validateCommitteeBriefingSourceListCitations,
  validateEvidenceCitations,
  type GrantBriefingApplication,
  type GrantBriefingPreparedDocument
} from "../../lib/knowledge/briefing";
import type { GrantAnalysisReportEvidenceInput } from "../../lib/knowledge/reports";
import { knowledgeAnswerWorkerTestHooks } from "../../workers/knowledge-answer-worker";

function evidenceFixture(
  citationNumber: number,
  overrides: Partial<GrantAnalysisReportEvidenceInput> = {}
): GrantAnalysisReportEvidenceInput {
  return {
    citationNumber,
    knowledgeDocumentId: `00000000-0000-4000-8000-${String(citationNumber).padStart(12, "0")}`,
    documentKey: `application:test:evidence:${citationNumber}`,
    contentHash: `hash-${citationNumber}`,
    evidenceRole: "current",
    retrievalRank: 1,
    applicationId: "00000000-0000-4000-8000-000000000001",
    sourceRecordId: null,
    title: `Evidence ${citationNumber}`,
    sourceKind: "forum_link",
    sourceId: `source-${citationNumber}`,
    sourceUrl: `https://example.test/evidence/${citationNumber}`,
    contentSnapshot: `Exact provider-visible evidence ${citationNumber}.`,
    metadata: {},
    ...overrides
  };
}

const application: GrantBriefingApplication = {
  id: "00000000-0000-4000-8000-000000000001",
  canonicalKey: "github:1",
  title: "Evidence snapshot test",
  applicantName: "Example applicant",
  normalizedStatus: "under_review",
  requestedAmountUsd: "10000",
  createdAt: "2026-07-12T00:00:00.000Z"
};

function preparedDocument({
  id,
  content,
  documentKind = "application_summary",
  sourceKind = "canonical_application"
}: {
  id: string;
  content: string;
  documentKind?: string;
  sourceKind?: string;
}): GrantBriefingPreparedDocument {
  return {
    documentKey: `application:${application.id}:${id}`,
    contentHash: `hash-${id}`,
    sourceRecordId: "00000000-0000-4000-8000-000000000099",
    evidenceRole: "current",
    retrievalRank: 1,
    result: {
      id,
      applicationId: application.id,
      documentKind,
      title: `Evidence ${id}`,
      applicantName: application.applicantName,
      sourceKind,
      sourceId: `source-${id}`,
      sourceUrl: `https://example.test/${id}`,
      normalizedStatus: application.normalizedStatus,
      requestedAmountUsd: application.requestedAmountUsd,
      rank: 1,
      excerpt: content.slice(0, 420),
      content
    }
  };
}

test("source-list repair replaces extras and preserves body citation order", () => {
  const evidence = [evidenceFixture(1), evidenceFixture(2), evidenceFixture(3)];
  const answer = [
    "## 1. Executive summary and decision snapshot",
    "The discussion raised one concern [2], while the application supplies context [1].",
    "## 9. Numbered source list",
    "- [1] Application",
    "- [3] Unused source"
  ].join("\n");
  const repaired = knowledgeAnswerWorkerTestHooks.ensureCommitteeBriefingSourceList(
    answer,
    evidence
  );
  const validation = validateCommitteeBriefingSourceListCitations(repaired);

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.citedNumbers, [2, 1]);
  assert.deepEqual(validation.listedNumbers, [1, 2]);
  assert.doesNotMatch(repaired, /Unused source/);
  assert.ok(repaired.indexOf("[2] Evidence 2") < repaired.indexOf("[1] Evidence 1"));
});

test("saved report snapshots exactly match each provider-visible evidence body", () => {
  const forumRaw = [
    "Grant application: Evidence snapshot test",
    "Applicant: Example applicant",
    "Status: under_review",
    "Source URL: https://example.test/forum",
    `Post #1 by alice: ${"Substantive Forum discussion. ".repeat(100)}`
  ].join("\n");
  const pack = assembleGrantBriefingEvidence({
    application,
    currentDocuments: [
      preparedDocument({ id: "summary", content: "Application evidence." }),
      preparedDocument({
        id: "forum",
        content: forumRaw,
        documentKind: "forum_discussion_chunk",
        sourceKind: "forum_link"
      })
    ],
    selectedDocuments: [],
    relationships: [],
    participantMatches: [],
    similarApprovedApplicationIds: [],
    similarDeclinedApplicationIds: [],
    retrievalMode: "hybrid",
    similarApplicationsPerOutcome: 3,
    templateKey: COMMITTEE_BRIEFING_TEMPLATE_KEY,
    templateVersion: COMMITTEE_BRIEFING_TEMPLATE_VERSION,
    model: "test-model"
  });
  const storedEvidence = knowledgeAnswerWorkerTestHooks.grantAnalysisReportEvidence(pack);
  const providerEvidence = formatGrantBriefingEvidenceForPrompt(pack.evidence);

  assert.equal(storedEvidence.length, pack.evidence.length);
  storedEvidence.forEach((stored, index) => {
    const packed = pack.evidence[index];
    assert.equal(stored.contentSnapshot, packed.content);
    assert.equal(stored.metadata.providerVisibleContentChars, packed.content.length);
    assert.equal(stored.sourceRecordId, pack.manifest.documents[index].sourceRecordId);
    assert.match(
      providerEvidence,
      new RegExp(`Evidence text:\\n${packed.content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nEND UNTRUSTED SOURCE TEXT`)
    );
  });
  assert.doesNotMatch(storedEvidence[1].contentSnapshot ?? "", /Grant application:/);
  assert.match(storedEvidence[1].contentSnapshot ?? "", /Post #1 by alice/);
});

test("generated source-list entries sanitize URLs without emitting broken truncations", () => {
  const sanitized = knowledgeAnswerWorkerTestHooks.sourceListEntry(evidenceFixture(1, {
    sourceUrl: "https://example.test/evidence/1\n?view=full"
  }));
  const oversized = knowledgeAnswerWorkerTestHooks.sourceListEntry(evidenceFixture(2, {
    sourceUrl: `https://example.test/${"x".repeat(700)}`
  }));

  assert.match(sanitized, /https:\/\/example\.test\/evidence\/1\?view=full/);
  assert.doesNotMatch(sanitized, /\n/);
  assert.doesNotMatch(oversized, /https:\/\//);
});

test("a source-list-only citation cannot satisfy grounded body citation validation", () => {
  const evidence = [evidenceFixture(1)];
  const answer = [
    "## 1. Executive summary and decision snapshot",
    "The request appears feasible, but no body citation was supplied.",
    "## 9. Numbered source list",
    "- [1] Application"
  ].join("\n");
  const repaired = knowledgeAnswerWorkerTestHooks.ensureCommitteeBriefingSourceList(
    answer,
    evidence
  );
  const body = knowledgeAnswerWorkerTestHooks.committeeBriefingBody(repaired);

  assert.equal(validateEvidenceCitations(body, 1).valid, false);
  assert.doesNotMatch(repaired, /\[1\]/);
  assert.match(repaired, /No grounded sources were cited/);
});

test("bounded answer truncation preserves valid UTF-8 and the exact byte ceiling", () => {
  const answer = "Evidence 😀 café 漢字 ".repeat(500);
  const bounded = knowledgeAnswerWorkerTestHooks.boundedGeneratedAnswer(answer, 1_003);

  assert.ok(Buffer.byteLength(bounded, "utf8") <= 1_003);
  assert.doesNotMatch(bounded, /�/);
  assert.match(bounded, /stored-answer safety limit/);
});

test("committee answer bounding keeps the repaired source list inside the byte ceiling", () => {
  const evidence = Array.from({ length: 6 }, (_, index) => evidenceFixture(index + 1, {
    title: `Evidence ${index + 1} ${"title ".repeat(20)}`,
    sourceUrl: `https://example.test/evidence/${index + 1}`
  }));
  const answer = [
    "## 1. Executive summary and decision snapshot",
    `${"Decision-relevant narrative. ".repeat(500)} [1][2]`,
    "## 2. Applicant and team track record",
    `${"Track-record evidence. ".repeat(150)} [3]`,
    "## 3. Proposal scope, milestones, budget, technical approach, and dependencies",
    "Grounded scope [4].",
    "## 4. Community discussion, arguments, responses, and resolution",
    "Grounded discussion [5].",
    "## 5. Relevant precedents and documented outcomes",
    "Grounded precedent [6].",
    "## 6. Material risks and execution considerations",
    "Grounded risks [1].",
    "## 7. Material gaps and questions for the applicant",
    "Grounded questions [2].",
    "## 8. Neutral decision considerations",
    "Grounded considerations [3].",
    "## 9. Numbered source list",
    "- [6] Incomplete original list"
  ].join("\n");
  const bounded = knowledgeAnswerWorkerTestHooks.boundedCommitteeBriefingAnswer(
    answer,
    evidence,
    24_000
  );

  assert.ok(Buffer.byteLength(bounded, "utf8") <= 24_000);
  assert.equal(validateCommitteeBriefingSourceListCitations(bounded).valid, true);
  assert.match(bounded, /## 9\. Numbered source list/);
  assert.match(bounded, /\[1\] Evidence 1/);
  assert.match(bounded, /\[6\] Evidence 6/);
});
