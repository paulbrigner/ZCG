import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { closePool } from "../lib/db";
import { recordAuditEvent } from "../lib/audit";
import {
  claimGrantKnowledgeAnswerJob,
  completeGrantKnowledgeAnswerJob,
  failGrantKnowledgeAnswerJob
} from "../lib/knowledge/answer-jobs";
import {
  COMMITTEE_BRIEFING_TEMPLATE_KEY,
  COMMITTEE_BRIEFING_TEMPLATE_VERSION,
  CUSTOM_GRANT_ANALYSIS_TEMPLATE_KEY,
  CUSTOM_GRANT_ANALYSIS_TEMPLATE_VERSION,
  buildGrantAnalysisPrompt,
  buildGrantBriefingEvidence,
  missingCommitteeBriefingSections,
  validateEvidenceCitations
} from "../lib/knowledge/briefing";
import { composeGroundedGrantAnalysis } from "../lib/knowledge/compose";
import { knowledgeAiBaseUrl, knowledgeAiModel, knowledgeProviderStatus } from "../lib/knowledge/config";
import {
  claimGrantAnalysisReport,
  completeGrantAnalysisReport,
  failGrantAnalysisReport,
  type GrantAnalysisReportEvidenceInput
} from "../lib/knowledge/reports";
import type { GrantKnowledgeSearchResponse } from "../lib/knowledge/search";
import { runGrantKnowledgeSearch } from "../lib/knowledge/search";

const secretsManager = new SecretsManagerClient({});

type WorkerEvent = {
  jobId?: string;
};

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function secretApiKey(secretString: string) {
  const trimmed = secretString.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return (
      stringValue(parsed.ZCG_KNOWLEDGE_AI_API_KEY) ??
      stringValue(parsed.ZCG_KNOWLEDGE_EMBEDDING_API_KEY) ??
      stringValue(parsed.VENICE_API_KEY) ??
      stringValue(parsed.apiKey) ??
      stringValue(parsed.key) ??
      stringValue(parsed.token) ??
      stringValue(parsed.secret)
    );
  } catch {
    return trimmed;
  }
}

function boundedGeneratedAnswer(value: string, maxBytes: number) {
  const suffix = "\n\n[Response truncated at the stored-answer safety limit.]";
  const encoded = Buffer.from(value, "utf8");

  if (encoded.byteLength <= maxBytes) {
    return value;
  }

  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  return `${encoded.subarray(0, Math.max(0, maxBytes - suffixBytes)).toString("utf8")}${suffix}`;
}

async function configureKnowledgeApiKeys() {
  if (
    (process.env.ZCG_KNOWLEDGE_AI_API_KEY || process.env.VENICE_API_KEY) &&
    process.env.ZCG_KNOWLEDGE_EMBEDDING_API_KEY
  ) {
    return;
  }

  const secretId =
    process.env.ZCG_KNOWLEDGE_AI_API_KEY_SECRET_ID ??
    process.env.ZCG_KNOWLEDGE_EMBEDDING_API_KEY_SECRET_ID ??
    process.env.VENICE_API_KEY_SECRET_ID;

  if (!secretId) {
    return;
  }

  const response = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
  const key = response.SecretString ? secretApiKey(response.SecretString) : null;

  if (!key) {
    throw new Error(`Knowledge API key secret ${secretId} did not contain a usable key.`);
  }

  process.env.ZCG_KNOWLEDGE_AI_API_KEY ||= key;
  process.env.ZCG_KNOWLEDGE_EMBEDDING_API_KEY ||= key;
}

async function recordAnalysisAudit(input: Parameters<typeof recordAuditEvent>[0]) {
  await recordAuditEvent(input).catch((error) => {
    console.error(`Failed to record ${input.action} audit event`, error);
  });
}

async function runApplicationAnalysis(job: NonNullable<Awaited<ReturnType<typeof claimGrantKnowledgeAnswerJob>>>) {
  const applicationId = job.request.applicationId;

  if (!applicationId) {
    throw new Error("Application-scoped analysis requires applicationId.");
  }

  const purpose = job.request.purpose === "committee_briefing" ? "committee_briefing" : "custom";
  const startedAt = Date.now();
  let claimedReport: Awaited<ReturnType<typeof claimGrantAnalysisReport>> = null;

  if (job.request.reportId) {
    claimedReport = await claimGrantAnalysisReport(job.request.reportId);

    if (!claimedReport) {
      throw new Error("Saved grant analysis report could not be claimed.");
    }
  }

  await recordAnalysisAudit({
    actorPrincipalId: job.principalId,
    action: "grant.analysis.started",
    targetType: "grant_application",
    targetId: applicationId,
    metadata: {
      reportId: job.request.reportId ?? null,
      jobId: job.id,
      purpose
    }
  });

  const evidencePack = await buildGrantBriefingEvidence({
    applicationId,
    retrievalMode: job.request.allowSemanticSearch ? job.request.retrievalMode : "keyword",
    templateKey: purpose === "committee_briefing"
      ? COMMITTEE_BRIEFING_TEMPLATE_KEY
      : CUSTOM_GRANT_ANALYSIS_TEMPLATE_KEY,
    templateVersion: purpose === "committee_briefing"
      ? COMMITTEE_BRIEFING_TEMPLATE_VERSION
      : CUSTOM_GRANT_ANALYSIS_TEMPLATE_VERSION
  });
  const prompt = buildGrantAnalysisPrompt({
    evidencePack,
    purpose,
    customPrompt: job.request.customPrompt
  });
  const configuredTimeoutMs = Number(process.env.ZCG_KNOWLEDGE_AI_TIMEOUT_MS);
  const composedAnswer = await composeGroundedGrantAnalysis({
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    temperature: 0.15,
    timeoutMs: Number.isFinite(configuredTimeoutMs) ? Math.max(90_000, configuredTimeoutMs) : 90_000,
    maxTokens: purpose === "committee_briefing" ? 5_000 : 2_200
  });
  const answerText = boundedGeneratedAnswer(
    composedAnswer,
    purpose === "committee_briefing" ? 24_000 : 14_000
  );
  const citationValidation = validateEvidenceCitations(answerText, evidencePack.evidence);

  if (!citationValidation.valid) {
    const detail = citationValidation.invalidNumbers.length
      ? ` Invalid citation(s): ${citationValidation.invalidNumbers.join(", ")}.`
      : " The response did not cite the supplied evidence.";
    throw new Error(`Grounded analysis failed citation validation.${detail}`);
  }

  if (citationValidation.citedNumbers.length > 24) {
    throw new Error("Grounded analysis cited more than the 24-source response safety limit.");
  }

  if (purpose === "committee_briefing") {
    const missingSections = missingCommitteeBriefingSections(answerText);

    if (missingSections.length) {
      throw new Error(
        `Committee briefing response was incomplete (missing section${missingSections.length === 1 ? "" : "s"}: ${missingSections.join(", ")}).`
      );
    }
  }

  const providerStatus = knowledgeProviderStatus();
  const citedNumbers = new Set(citationValidation.citedNumbers);
  const jobResults = job.request.reportId
    ? []
    : evidencePack.evidence.filter((item) => citedNumbers.has(item.citationNumber)).map((item) => ({
        id: item.id,
        applicationId: item.applicationId,
        documentKind: item.documentKind.slice(0, 64),
        title: item.title.slice(0, 120),
        applicantName: item.applicantName?.slice(0, 80) ?? null,
        sourceKind: item.sourceKind?.slice(0, 64) ?? null,
        sourceId: item.sourceId?.slice(0, 120) ?? null,
        sourceUrl: item.sourceUrl?.slice(0, 240) ?? null,
        normalizedStatus: item.normalizedStatus?.slice(0, 64) ?? null,
        requestedAmountUsd: item.requestedAmountUsd?.slice(0, 48) ?? null,
        rank: item.rank,
        excerpt: item.excerpt.slice(0, 160),
        content: "",
        citationNumber: item.citationNumber
      }));
  const response: GrantKnowledgeSearchResponse = {
    ok: true,
    query: job.request.searchText,
    answerMode: "ai",
    retrievalMode: evidencePack.retrievalMode,
    answerText,
    answerStatus: "generated",
    results: jobResults,
    retrievalStats: {
      resultCount: evidencePack.evidence.length,
      initialResultCount: evidencePack.evidence.filter((item) => item.evidenceRole === "current").length,
      expandedEvidenceCount: evidencePack.evidence.length,
      candidateResultCount: evidencePack.evidence.length,
      limit: job.request.limit,
      mode: evidencePack.retrievalMode,
      semanticSearchEnabled: providerStatus.semanticSearchEnabled
    },
    providerStatus
  };

  if (job.request.reportId) {
    const manifestByCitation = new Map(
      evidencePack.manifest.documents.map((item) => [item.citationNumber, item])
    );
    const evidence: GrantAnalysisReportEvidenceInput[] = evidencePack.evidence.map((item) => {
      const manifest = manifestByCitation.get(item.citationNumber);

      return {
        citationNumber: item.citationNumber,
        knowledgeDocumentId: item.id,
        documentKey: item.documentKey,
        contentHash: item.contentHash,
        evidenceRole: item.evidenceRole,
        retrievalRank: item.retrievalRank,
        applicationId: item.applicationId,
        sourceRecordId: manifest?.sourceRecordId ?? null,
        title: item.title,
        sourceKind: item.sourceKind,
        sourceId: item.sourceId,
        sourceUrl: item.sourceUrl,
        contentSnapshot: item.content,
        metadata: {
          documentKind: item.documentKind,
          excerpt: item.excerpt
        }
      };
    });

    await completeGrantAnalysisReport({
      reportId: job.request.reportId,
      answerText,
      answerStatus: "generated",
      evidenceFingerprint: evidencePack.fingerprint,
      provider: new URL(knowledgeAiBaseUrl()).hostname,
      model: knowledgeAiModel(),
      latencyMs: Date.now() - startedAt,
      evidence,
      generationMetadata: {
        purpose,
        retrievalMode: evidencePack.retrievalMode,
        evidenceCount: evidencePack.evidence.length,
        warnings: evidencePack.warnings,
        citationValidation,
        evidenceSelection: {
          relationshipCount: evidencePack.manifest.relationships.length,
          participantMatchCount: evidencePack.manifest.participantMatches.length,
          similarApplicationIds: evidencePack.manifest.similarApplicationIds
        }
      }
    });
  }

  await recordAnalysisAudit({
    actorPrincipalId: job.principalId,
    action: "grant.analysis.completed",
    targetType: "grant_application",
    targetId: applicationId,
    metadata: {
      reportId: job.request.reportId ?? null,
      jobId: job.id,
      purpose,
      evidenceCount: evidencePack.evidence.length,
      evidenceFingerprint: evidencePack.fingerprint
    }
  });

  if (claimedReport?.visibility === "shared") {
    await recordAnalysisAudit({
      actorPrincipalId: job.principalId,
      action: "grant.analysis.published",
      targetType: "grant_analysis_report",
      targetId: claimedReport.id,
      metadata: {
        applicationId,
        reportType: claimedReport.reportType,
        versionNumber: claimedReport.versionNumber,
        jobId: job.id
      }
    });
  }

  return response;
}

export async function handler(event: WorkerEvent = {}) {
  const jobId = stringValue(event.jobId);

  if (!jobId) {
    throw new Error("Knowledge answer worker requires jobId.");
  }

  const job = await claimGrantKnowledgeAnswerJob(jobId);

  if (!job) {
    return { ok: true, skipped: true, reason: "job_not_queued_or_expired", jobId };
  }

  try {
    await configureKnowledgeApiKeys();

    const applicationAnalysis =
      job.request.purpose === "committee_briefing" || job.request.purpose === "custom_analysis";
    const result = applicationAnalysis
      ? await runApplicationAnalysis(job)
      : await runGrantKnowledgeSearch({
          searchText: job.request.searchText,
          limit: job.request.limit,
          answerMode: job.request.answerMode,
          retrievalMode: job.request.retrievalMode,
          allowAiAnswer: job.request.allowAiAnswer,
          allowSemanticSearch: job.request.allowSemanticSearch,
          principalId: job.principalId
        });

    await completeGrantKnowledgeAnswerJob(job.id, result);

    return {
      ok: true,
      jobId: job.id,
      status: "succeeded",
      resultCount: result.retrievalStats.resultCount,
      answerStatus: result.answerStatus
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (job.request.reportId) {
      await failGrantAnalysisReport(job.request.reportId, message, {
        jobId: job.id,
        failedAt: new Date().toISOString()
      }).catch((reportError) => {
        console.error("Failed to mark saved grant analysis failed", reportError);
      });
    }
    await failGrantKnowledgeAnswerJob(job.id, message).catch((failError) => {
      console.error("Failed to mark knowledge answer job failed", failError);
    });
    if (job.request.applicationId) {
      await recordAnalysisAudit({
        actorPrincipalId: job.principalId,
        action: "grant.analysis.failed",
        targetType: "grant_application",
        targetId: job.request.applicationId,
        metadata: {
          reportId: job.request.reportId ?? null,
          jobId: job.id,
          purpose: job.request.purpose ?? "knowledge_search",
          error: message
        }
      });
    }

    return {
      ok: false,
      jobId: job.id,
      status: "failed",
      error: message
    };
  }
}

if (process.argv[1]?.endsWith("knowledge-answer-worker.ts")) {
  handler({
    jobId: process.env.ZCG_KNOWLEDGE_ANSWER_JOB_ID
  })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}
