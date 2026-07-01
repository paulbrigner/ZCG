const defaultAiBaseUrl = "https://api.venice.ai/api/v1";
const defaultAiModel = "openai-gpt-55";
const defaultEmbeddingModel = "text-embedding-bge-m3";
const defaultEmbeddingDims = 1024;
const defaultAiTimeoutMs = 20000;

function stringValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function booleanValue(value: string | undefined, fallback: boolean) {
  const normalized = stringValue(value)?.toLowerCase();

  if (!normalized) {
    return fallback;
  }

  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function knowledgeAiApiKey() {
  return stringValue(process.env.ZCG_KNOWLEDGE_AI_API_KEY) ?? stringValue(process.env.VENICE_API_KEY);
}

export function knowledgeAiBaseUrl() {
  return (stringValue(process.env.ZCG_KNOWLEDGE_AI_BASE_URL) ?? defaultAiBaseUrl).replace(/\/+$/, "");
}

export function knowledgeAiModel() {
  return stringValue(process.env.ZCG_KNOWLEDGE_AI_MODEL) ?? defaultAiModel;
}

export function knowledgeAiTimeoutMs() {
  return positiveInteger(process.env.ZCG_KNOWLEDGE_AI_TIMEOUT_MS, defaultAiTimeoutMs);
}

export function knowledgeAiEnabled() {
  return booleanValue(process.env.ZCG_KNOWLEDGE_AI_ENABLED, true) && Boolean(knowledgeAiApiKey());
}

export function knowledgeEmbeddingModel() {
  return stringValue(process.env.ZCG_KNOWLEDGE_EMBEDDING_MODEL) ?? defaultEmbeddingModel;
}

export function knowledgeEmbeddingDims() {
  return positiveInteger(process.env.ZCG_KNOWLEDGE_EMBEDDING_DIMS, defaultEmbeddingDims);
}

export function knowledgeProviderStatus() {
  return {
    aiAnswerEnabled: knowledgeAiEnabled(),
    aiConfigured: Boolean(knowledgeAiApiKey()),
    aiBaseUrl: knowledgeAiBaseUrl(),
    aiModel: knowledgeAiModel(),
    embeddingModel: knowledgeEmbeddingModel(),
    embeddingDims: knowledgeEmbeddingDims(),
    semanticSearchEnabled: false
  };
}
