import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGrantAnalysisEvidenceFingerprint,
  isGrantAnalysisReportFresh,
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
