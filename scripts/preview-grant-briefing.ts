import { closePool } from "../lib/db";
import {
  buildGrantAnalysisPrompt,
  buildGrantBriefingEvidence
} from "../lib/knowledge/briefing";

function compact(value: string, maxChars = 360) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars
    ? `${normalized.slice(0, Math.max(0, maxChars - 3))}...`
    : normalized;
}

function postNumbers(value: string) {
  return [...new Set(
    [...value.matchAll(/\bPost #(\d+)\b/gi)].map((match) => Number(match[1]))
  )].filter((postNumber) => Number.isInteger(postNumber));
}

async function main() {
  const applicationId = process.argv[2]?.trim();

  if (!applicationId) {
    throw new Error(
      "Usage: npm run knowledge:briefing-preview -- <application-id>"
    );
  }

  const evidencePack = await buildGrantBriefingEvidence({ applicationId });
  const prompt = buildGrantAnalysisPrompt({
    evidencePack,
    purpose: "committee_briefing"
  });

  console.log(JSON.stringify({
    application: evidencePack.application,
    template: {
      key: prompt.templateKey,
      version: prompt.templateVersion
    },
    fingerprint: evidencePack.fingerprint,
    packing: evidencePack.packing,
    warnings: evidencePack.warnings,
    evidence: evidencePack.evidence.map((item) => {
      const posts = postNumbers(item.content);
      return {
        citationNumber: item.citationNumber,
        knowledgeDocumentId: item.id,
        evidenceRole: item.evidenceRole,
        documentKind: item.documentKind,
        title: item.title,
        sourceUrl: item.sourceUrl,
        contentChars: item.content.length,
        postCount: posts.length,
        firstPostNumber: posts[0] ?? null,
        lastPostNumber: posts.at(-1) ?? null,
        preview: compact(item.content)
      };
    })
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
