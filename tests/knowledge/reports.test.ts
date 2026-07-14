import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGrantAnalysisEvidenceFingerprint,
  compareGrantAnalysisReportEvidence,
  getGrantAnalysisReportFreshnessDetails,
  grantAnalysisEvidenceChangeStatus,
  isGrantAnalysisReportFresh,
  isPublishedCommitteeBriefing,
  stableFingerprintValue,
  type GrantAnalysisEvidenceFingerprintInput
} from "../../lib/knowledge/reports";

function fingerprintInput(): GrantAnalysisEvidenceFingerprintInput {
  return {
    documents: [
      {
        knowledgeDocumentId: "00000000-0000-4000-8000-000000000001",
        contentHash: "content-one",
        evidenceRole: "current",
        applicationId: "00000000-0000-4000-8000-000000000010",
        citationNumber: 1
      },
      {
        knowledgeDocumentId: "00000000-0000-4000-8000-000000000002",
        contentHash: "content-two",
        evidenceRole: "similar_declined",
        applicationId: "00000000-0000-4000-8000-000000000020",
        citationNumber: 2
      }
    ],
    relationships: [{ type: "resubmission", applicationId: "related-1" }],
    participants: [{ normalizedName: "example team", reviewStatus: "accepted" }],
    template: { key: "committee_briefing", version: "1" },
    retrievalConfiguration: { mode: "hybrid", comparisonLimit: 8 },
    modelConfiguration: { provider: "example", model: "grounded-1", temperature: 0.2 }
  };
}

test("stable fingerprint serialization ignores object insertion order", () => {
  assert.equal(
    stableFingerprintValue({ z: 1, nested: { b: 2, a: 1 }, a: 3 }),
    stableFingerprintValue({ a: 3, nested: { a: 1, b: 2 }, z: 1 })
  );
});

test("grant analysis evidence fingerprints are deterministic and evidence-order sensitive", () => {
  const input = fingerprintInput();
  const first = buildGrantAnalysisEvidenceFingerprint(input);
  const second = buildGrantAnalysisEvidenceFingerprint({
    modelConfiguration: { temperature: 0.2, model: "grounded-1", provider: "example" },
    retrievalConfiguration: { comparisonLimit: 8, mode: "hybrid" },
    template: { version: "1", key: "committee_briefing" },
    participants: [{ reviewStatus: "accepted", normalizedName: "example team" }],
    relationships: [{ applicationId: "related-1", type: "resubmission" }],
    documents: input.documents
  });

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(
    first,
    buildGrantAnalysisEvidenceFingerprint({ ...input, documents: [...input.documents].reverse() })
  );
});

test("template, content, retrieval, and model changes make a report stale", () => {
  const input = fingerprintInput();
  const saved = buildGrantAnalysisEvidenceFingerprint(input);

  assert.equal(isGrantAnalysisReportFresh(saved, saved), true);
  assert.equal(isGrantAnalysisReportFresh({ evidenceFingerprint: saved }, saved), true);
  assert.equal(isGrantAnalysisReportFresh(null, saved), false);
  assert.equal(isGrantAnalysisReportFresh(saved, null), false);

  assert.notEqual(
    saved,
    buildGrantAnalysisEvidenceFingerprint({
      ...input,
      documents: input.documents.map((document, index) =>
        index === 0 ? { ...document, contentHash: "changed" } : document
      )
    })
  );
  assert.notEqual(
    saved,
    buildGrantAnalysisEvidenceFingerprint({
      ...input,
      template: { ...input.template, version: "2" }
    })
  );
  assert.notEqual(
    saved,
    buildGrantAnalysisEvidenceFingerprint({
      ...input,
      retrievalConfiguration: { mode: "hybrid", comparisonLimit: 12 }
    })
  );
  assert.notEqual(
    saved,
    buildGrantAnalysisEvidenceFingerprint({
      ...input,
      modelConfiguration: { provider: "example", model: "grounded-2", temperature: 0.2 }
    })
  );
});

test("report evidence freshness ignores documents that were not in the saved briefing", () => {
  const savedEvidence = [
    { documentKey: "application:summary", contentHash: "summary-v1" },
    { documentKey: "application:github", contentHash: "github-v1" }
  ];
  const currentEvidence = [
    ...savedEvidence,
    { documentKey: "unrelated:comparison:document", contentHash: "changed-after-report" }
  ];

  assert.deepEqual(compareGrantAnalysisReportEvidence(savedEvidence, currentEvidence), {
    evidenceRecordCount: 2,
    changedEvidenceRecordCount: 0
  });
});

test("report evidence freshness counts changed and missing saved records", () => {
  const savedEvidence = [
    { documentKey: "application:summary", contentHash: "summary-v1" },
    { documentKey: "application:github", contentHash: "github-v1" },
    { documentKey: "application:sheet", contentHash: "sheet-v1" }
  ];
  const currentEvidence = [
    { documentKey: "application:summary", contentHash: "summary-v2" },
    { documentKey: "application:github", contentHash: "github-v1" }
  ];

  assert.deepEqual(compareGrantAnalysisReportEvidence(savedEvidence, currentEvidence), {
    evidenceRecordCount: 3,
    changedEvidenceRecordCount: 2
  });
  assert.deepEqual(compareGrantAnalysisReportEvidence([], currentEvidence), {
    evidenceRecordCount: 0,
    changedEvidenceRecordCount: 0
  });
});

test("individual report evidence identifies current, changed, and missing records", () => {
  assert.equal(grantAnalysisEvidenceChangeStatus("hash-v1", "hash-v1"), "current");
  assert.equal(grantAnalysisEvidenceChangeStatus("hash-v1", "hash-v2"), "changed");
  assert.equal(grantAnalysisEvidenceChangeStatus("hash-v1", null), "missing");
});

test("report freshness queries only the saved evidence snapshot and returns precise reasons", async () => {
  const queries: string[] = [];
  const matchingRows = [
    {
      saved_document_key: "application:summary",
      saved_content_hash: "summary-v1",
      current_document_key: "application:summary",
      current_content_hash: "summary-v1"
    }
  ];
  const dependencies = {
    query: async <T extends Record<string, unknown>>(text: string) => {
      queries.push(text);
      return { rows: matchingRows as unknown as T[] };
    }
  };
  const input = {
    report: {
      id: "00000000-0000-4000-8000-000000000030",
      status: "succeeded" as const,
      evidenceFingerprint: "saved-fingerprint",
      completedAt: "2026-07-13T15:13:00.000Z",
      templateKey: "zcg_committee_briefing",
      templateVersion: "4",
      model: "grounded-model"
    },
    currentTemplateKey: "zcg_committee_briefing",
    currentTemplateVersion: "4",
    currentModel: "grounded-model"
  };

  assert.deepEqual(await getGrantAnalysisReportFreshnessDetails(input, dependencies), {
    status: "fresh",
    evidenceStatus: "current",
    evidenceRecordCount: 1,
    changedEvidenceRecordCount: 0,
    templateChanged: false,
    modelChanged: false
  });
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0], /indexed_at|application_id|grant_application_relationships|grant_application_participants/);

  assert.deepEqual(
    await getGrantAnalysisReportFreshnessDetails(
      { ...input, currentTemplateVersion: "5" },
      dependencies
    ),
    {
      status: "stale",
      evidenceStatus: "current",
      evidenceRecordCount: 1,
      changedEvidenceRecordCount: 0,
      templateChanged: true,
      modelChanged: false
    }
  );

  const noSnapshot = await getGrantAnalysisReportFreshnessDetails(input, {
    query: async <T extends Record<string, unknown>>() => ({ rows: [] as T[] })
  });
  assert.equal(noSnapshot.status, "unknown");
  assert.equal(noSnapshot.evidenceStatus, "unknown");

  const changedSnapshot = await getGrantAnalysisReportFreshnessDetails(input, {
    query: async <T extends Record<string, unknown>>() => ({
      rows: [{ ...matchingRows[0], current_content_hash: "summary-v2" }] as unknown as T[]
    })
  });
  assert.equal(changedSnapshot.status, "stale");
  assert.equal(changedSnapshot.evidenceStatus, "changed");
  assert.equal(changedSnapshot.changedEvidenceRecordCount, 1);
});

test("only completed shared committee briefings with content are publicly viewable", () => {
  const published = {
    reportType: "committee_briefing" as const,
    visibility: "shared" as const,
    status: "succeeded" as const,
    answerText: "Grounded briefing"
  };

  assert.equal(isPublishedCommitteeBriefing(published), true);
  assert.equal(isPublishedCommitteeBriefing({ ...published, reportType: "custom" }), false);
  assert.equal(isPublishedCommitteeBriefing({ ...published, visibility: "private" }), false);
  assert.equal(isPublishedCommitteeBriefing({ ...published, status: "running" }), false);
  assert.equal(isPublishedCommitteeBriefing({ ...published, status: "failed" }), false);
  assert.equal(isPublishedCommitteeBriefing({ ...published, answerText: "  " }), false);
  assert.equal(isPublishedCommitteeBriefing(null), false);
});
