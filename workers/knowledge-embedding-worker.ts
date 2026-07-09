import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { closePool, query } from "../lib/db";
import {
  getGrantKnowledgeEmbeddingStatus,
  refreshGrantKnowledgeEmbeddings
} from "../lib/knowledge/embeddings";

const secretsManager = new SecretsManagerClient({});

type WorkerEvent = {
  maxDocuments?: number;
};

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

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
      stringValue(parsed.ZCG_KNOWLEDGE_EMBEDDING_API_KEY) ??
      stringValue(parsed.ZCG_KNOWLEDGE_AI_API_KEY) ??
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

async function configureEmbeddingApiKey() {
  if (
    process.env.ZCG_KNOWLEDGE_EMBEDDING_API_KEY ||
    process.env.ZCG_KNOWLEDGE_AI_API_KEY ||
    process.env.VENICE_API_KEY
  ) {
    return;
  }

  const secretId =
    process.env.ZCG_KNOWLEDGE_EMBEDDING_API_KEY_SECRET_ID ??
    process.env.ZCG_KNOWLEDGE_AI_API_KEY_SECRET_ID ??
    process.env.VENICE_API_KEY_SECRET_ID;

  if (!secretId) {
    return;
  }

  const response = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
  const key = response.SecretString ? secretApiKey(response.SecretString) : null;

  if (!key) {
    throw new Error(`Embedding API key secret ${secretId} did not contain a usable key.`);
  }

  process.env.ZCG_KNOWLEDGE_EMBEDDING_API_KEY = key;
}

async function recordEmbeddingRun(
  action: "knowledge.embed.scheduled" | "knowledge.embed.scheduled.failed",
  metadata: Record<string, unknown>
) {
  await query(
    `insert into audit_events (action, target_type, metadata)
     values ($1, 'grant_knowledge', $2::jsonb)`,
    [action, JSON.stringify(metadata)]
  );
}

export async function handler(event: WorkerEvent = {}) {
  const maxDocuments = positiveInteger(
    event.maxDocuments,
    positiveInteger(process.env.ZCG_KNOWLEDGE_EMBED_MAX_DOCUMENTS, 200)
  );
  const startedAt = new Date().toISOString();

  try {
    await configureEmbeddingApiKey();

    const before = await getGrantKnowledgeEmbeddingStatus();
    const result = await refreshGrantKnowledgeEmbeddings({ maxDocuments });
    const after = await getGrantKnowledgeEmbeddingStatus();
    const metadata = {
      ...result,
      startedAt,
      completedAt: new Date().toISOString(),
      maxDocuments,
      before,
      after,
      remainingDocuments: after.embeddingBacklogCount
    };

    await recordEmbeddingRun("knowledge.embed.scheduled", metadata);
    return metadata;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await recordEmbeddingRun("knowledge.embed.scheduled.failed", {
      startedAt,
      completedAt: new Date().toISOString(),
      maxDocuments,
      error: message
    }).catch((auditError) => {
      console.error("Failed to record scheduled embedding failure", auditError);
    });

    throw error;
  }
}

if (process.argv[1]?.endsWith("knowledge-embedding-worker.ts")) {
  handler()
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
