import { query } from "@/lib/db";
import {
  knowledgeEmbeddingApiKey,
  knowledgeEmbeddingBaseUrl,
  knowledgeEmbeddingBatchSize,
  knowledgeEmbeddingDims,
  knowledgeEmbeddingModel,
  knowledgeEmbeddingTimeoutMs
} from "@/lib/knowledge/config";

type EmbeddingCandidateRow = {
  id: string;
  title: string;
  content: string;
  content_hash: string;
};

type EmbeddingResponse = {
  data?: Array<{
    embedding?: unknown;
    index?: number;
  }>;
  model?: string;
  usage?: unknown;
};

export type GrantKnowledgeEmbeddingResult = {
  ok: true;
  model: string;
  dims: number;
  documentsEmbedded: number;
  documentsSkipped: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function vectorLiteral(vector: number[]) {
  return `[${vector.map((value) => {
    if (!Number.isFinite(value)) {
      throw new Error("Embedding vector contains a non-finite value.");
    }

    return String(value);
  }).join(",")}]`;
}

function embeddingInput(row: EmbeddingCandidateRow) {
  return [`Title: ${row.title}`, "", row.content].join("\n").slice(0, 24000);
}

function parseEmbeddingVector(value: unknown, expectedDims: number) {
  if (!Array.isArray(value)) {
    throw new Error("Embedding response is missing a vector.");
  }

  const vector = value.map((entry) => Number(entry));

  if (vector.length !== expectedDims) {
    throw new Error(`Embedding dimension mismatch: expected ${expectedDims}, got ${vector.length}.`);
  }

  if (vector.some((entry) => !Number.isFinite(entry))) {
    throw new Error("Embedding vector contains a non-numeric value.");
  }

  return vector;
}

async function createEmbeddings(inputs: string[]) {
  const apiKey = knowledgeEmbeddingApiKey();

  if (!apiKey) {
    throw new Error("ZCG knowledge embedding key is not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), knowledgeEmbeddingTimeoutMs());

  try {
    const response = await fetch(`${knowledgeEmbeddingBaseUrl()}/embeddings`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: knowledgeEmbeddingModel(),
        input: inputs,
        encoding_format: "float"
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const snippet = detail.trim().slice(0, 240);
      throw new Error(`Embedding request failed (${response.status})${snippet ? `: ${snippet}` : ""}`);
    }

    const payload = (await response.json()) as EmbeddingResponse;
    const sorted = [...(payload.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));

    if (sorted.length !== inputs.length) {
      throw new Error(`Embedding response length mismatch: expected ${inputs.length}, got ${sorted.length}.`);
    }

    return sorted.map((item) => parseEmbeddingVector(item.embedding, knowledgeEmbeddingDims()));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchEmbeddingCandidates(limit: number) {
  const result = await query<EmbeddingCandidateRow>(
    `select id::text,
            title,
            content,
            content_hash
       from grant_knowledge_documents
      where embedding is null
         or embedding_model is distinct from $1
         or embedding_dims is distinct from $2
         or embedding_content_hash is distinct from content_hash
      order by indexed_at desc, id desc
      limit $3`,
    [knowledgeEmbeddingModel(), knowledgeEmbeddingDims(), limit]
  );

  return result.rows;
}

async function storeEmbedding(row: EmbeddingCandidateRow, vector: number[]) {
  await query(
    `update grant_knowledge_documents
        set embedding = ($1)::vector,
            embedding_model = $2,
            embedding_dims = $3,
            embedding_content_hash = $4,
            embedding_indexed_at = now(),
            updated_at = now()
      where id = $5`,
    [vectorLiteral(vector), knowledgeEmbeddingModel(), knowledgeEmbeddingDims(), row.content_hash, row.id]
  );
}

export async function refreshGrantKnowledgeEmbeddings({
  maxDocuments = 0
}: {
  maxDocuments?: number;
} = {}): Promise<GrantKnowledgeEmbeddingResult> {
  const model = knowledgeEmbeddingModel();
  const dims = knowledgeEmbeddingDims();
  const batchSize = knowledgeEmbeddingBatchSize();
  let documentsEmbedded = 0;
  let documentsSkipped = 0;

  while (maxDocuments <= 0 || documentsEmbedded + documentsSkipped < maxDocuments) {
    const remaining = maxDocuments > 0 ? maxDocuments - documentsEmbedded - documentsSkipped : batchSize;
    const candidates = await fetchEmbeddingCandidates(Math.min(batchSize, remaining));

    if (!candidates.length) {
      break;
    }

    const embeddings = await createEmbeddings(candidates.map(embeddingInput));

    for (const [index, candidate] of candidates.entries()) {
      try {
        await storeEmbedding(candidate, embeddings[index]);
        documentsEmbedded += 1;
      } catch (error) {
        console.error(`Failed to store embedding for ${candidate.id}`, error);
        documentsSkipped += 1;
      }
    }

    if (candidates.length < batchSize) {
      break;
    }

    await sleep(150);
  }

  return {
    ok: true,
    model,
    dims,
    documentsEmbedded,
    documentsSkipped
  };
}

export async function createQueryEmbedding(searchText: string) {
  const [vector] = await createEmbeddings([searchText]);
  return vector;
}

export { vectorLiteral };
