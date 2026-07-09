import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { closePool } from "../lib/db";
import {
  claimGrantKnowledgeAnswerJob,
  completeGrantKnowledgeAnswerJob,
  failGrantKnowledgeAnswerJob
} from "../lib/knowledge/answer-jobs";
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

    const result = await runGrantKnowledgeSearch({
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
    await failGrantKnowledgeAnswerJob(job.id, message).catch((failError) => {
      console.error("Failed to mark knowledge answer job failed", failError);
    });

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
