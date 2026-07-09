import { query } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { knowledgeAiEnabled, knowledgeEmbeddingDims, knowledgeEmbeddingModel, knowledgeProviderStatus } from "@/lib/knowledge/config";
import { composeGrantKnowledgeAnswer } from "@/lib/knowledge/compose";
import { createQueryEmbedding, getGrantKnowledgeEmbeddingStatus, vectorLiteral } from "@/lib/knowledge/embeddings";

export type KnowledgeAnswerMode = "evidence" | "ai";
export type KnowledgeRetrievalMode = "keyword" | "semantic" | "hybrid";

export type GrantKnowledgeSearchResult = {
  id: string;
  applicationId: string;
  documentKind: string;
  title: string;
  applicantName: string | null;
  sourceKind: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  normalizedStatus: string | null;
  requestedAmountUsd: string | null;
  rank: number;
  excerpt: string;
  content: string;
};

type GrantKnowledgeSearchRow = {
  id: string;
  application_id: string;
  document_kind: string;
  title: string;
  applicant_name: string | null;
  source_kind: string | null;
  source_id: string | null;
  source_url: string | null;
  normalized_status: string | null;
  requested_amount_usd: string | null;
  rank: string | number;
  content: string;
};

type GrantKnowledgeOverviewRow = {
  document_count: string;
  application_count: string;
  latest_indexed_at: string | null;
};

type GrantKnowledgeSourceKindRow = {
  source_kind: string;
  document_count: string;
};

type GrantKnowledgeEmbeddingRunRow = {
  action: string;
  created_at: string;
  metadata: string;
};

export type GrantKnowledgeOverview = {
  documentCount: number;
  applicationCount: number;
  embeddingCount: number;
  embeddingBacklogCount: number;
  staleEmbeddingCount: number;
  latestIndexedAt: string | null;
  latestEmbeddingIndexedAt: string | null;
  lastEmbeddingRunAt: string | null;
  lastEmbeddingRunAction: string | null;
  lastEmbeddingRunDocumentsEmbedded: number | null;
  lastEmbeddingRunDocumentsSkipped: number | null;
  sourceKinds: Array<{ sourceKind: string; documentCount: number }>;
};

export type GrantKnowledgeSearchResponse = {
  ok: true;
  query: string;
  answerMode: KnowledgeAnswerMode;
  retrievalMode: KnowledgeRetrievalMode;
  answerText: string | null;
  answerStatus: "evidence" | "generated" | "disabled" | "not_requested";
  results: GrantKnowledgeSearchResult[];
  retrievalStats: {
    resultCount: number;
    limit: number;
    mode: KnowledgeRetrievalMode;
    semanticSearchEnabled: boolean;
  };
  providerStatus: ReturnType<typeof knowledgeProviderStatus>;
};

const defaultLimit = 8;
const maxLimit = 20;

function parseJsonRecord(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeKnowledgeQuery(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 500) : "";
}

export function normalizeKnowledgeLimit(value: unknown) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return defaultLimit;
  }

  return Math.min(parsed, maxLimit);
}

export function normalizeAnswerMode(value: unknown): KnowledgeAnswerMode {
  return value === "ai" ? "ai" : "evidence";
}

export function normalizeRetrievalMode(value: unknown): KnowledgeRetrievalMode {
  if (value === "semantic" || value === "hybrid") {
    return value;
  }

  return "keyword";
}

function plainExcerpt(content: string, searchText: string) {
  const normalizedContent = content.replace(/\s+/g, " ").trim();
  const terms = searchText
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[^a-z0-9]/g, ""))
    .filter((term) => term.length >= 3);
  const lowerContent = normalizedContent.toLowerCase();
  const firstMatch = terms
    .map((term) => lowerContent.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];

  if (firstMatch === undefined) {
    return normalizedContent.slice(0, 360);
  }

  const start = Math.max(0, firstMatch - 130);
  const end = Math.min(normalizedContent.length, firstMatch + 360);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalizedContent.length ? "..." : "";
  return `${prefix}${normalizedContent.slice(start, end)}${suffix}`;
}

function mapSearchRow(row: GrantKnowledgeSearchRow, searchText: string): GrantKnowledgeSearchResult {
  return {
    id: row.id,
    applicationId: row.application_id,
    documentKind: row.document_kind,
    title: row.title,
    applicantName: row.applicant_name,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    normalizedStatus: row.normalized_status,
    requestedAmountUsd: row.requested_amount_usd,
    rank: Number(row.rank),
    excerpt: plainExcerpt(row.content, searchText),
    content: row.content
  };
}

function extractiveAnswer(searchText: string, results: GrantKnowledgeSearchResult[]) {
  if (!results.length) {
    return "No grounded grant records matched this query yet.";
  }

  const topResults = results.slice(0, 3);
  const lines = topResults.map((result, index) => {
    const applicant = result.applicantName ? `, ${result.applicantName}` : "";
    const status = result.normalizedStatus ? `, ${result.normalizedStatus}` : "";
    return `${index + 1}. ${result.title}${applicant}${status}`;
  });

  return [
    `Found ${results.length} grounded grant record${results.length === 1 ? "" : "s"} related to "${searchText}".`,
    "",
    ...lines
  ].join("\n");
}

export async function getGrantKnowledgeOverview(): Promise<GrantKnowledgeOverview> {
  const [overview, sourceKinds, embeddingStatus, lastEmbeddingRun] = await Promise.all([
    query<GrantKnowledgeOverviewRow>(
      `select count(*)::text as document_count,
              count(distinct application_id)::text as application_count,
              max(indexed_at)::text as latest_indexed_at
         from grant_knowledge_documents`
    ),
    query<GrantKnowledgeSourceKindRow>(
      `select coalesce(source_kind, document_kind) as source_kind,
              count(*)::text as document_count
         from grant_knowledge_documents
        group by coalesce(source_kind, document_kind)
        order by source_kind`
    ),
    getGrantKnowledgeEmbeddingStatus(),
    query<GrantKnowledgeEmbeddingRunRow>(
      `select action,
              created_at::text,
              metadata::text
         from audit_events
        where action in ('knowledge.embed', 'knowledge.embed.scheduled', 'knowledge.embed.scheduled.failed')
        order by created_at desc
        limit 1`
    )
  ]);
  const row = overview.rows[0];
  const lastRun = lastEmbeddingRun.rows[0];
  const lastRunMetadata = parseJsonRecord(lastRun?.metadata ?? null);

  return {
    documentCount: Number(row?.document_count ?? 0),
    applicationCount: Number(row?.application_count ?? 0),
    embeddingCount: embeddingStatus.embeddingCount,
    embeddingBacklogCount: embeddingStatus.embeddingBacklogCount,
    staleEmbeddingCount: embeddingStatus.staleEmbeddingCount,
    latestIndexedAt: row?.latest_indexed_at ?? null,
    latestEmbeddingIndexedAt: embeddingStatus.latestEmbeddingIndexedAt,
    lastEmbeddingRunAt: lastRun?.created_at ?? null,
    lastEmbeddingRunAction: lastRun?.action ?? null,
    lastEmbeddingRunDocumentsEmbedded: numberValue(lastRunMetadata.documentsEmbedded),
    lastEmbeddingRunDocumentsSkipped: numberValue(lastRunMetadata.documentsSkipped),
    sourceKinds: sourceKinds.rows.map((sourceKind) => ({
      sourceKind: sourceKind.source_kind,
      documentCount: Number(sourceKind.document_count)
    }))
  };
}

export async function searchGrantKnowledge({
  searchText,
  limit,
  retrievalMode = "keyword"
}: {
  searchText: string;
  limit: number;
  retrievalMode?: KnowledgeRetrievalMode;
}) {
  if (retrievalMode === "semantic") {
    return searchSemanticGrantKnowledge({ searchText, limit });
  }

  if (retrievalMode === "hybrid") {
    return searchHybridGrantKnowledge({ searchText, limit });
  }

  return searchKeywordGrantKnowledge({ searchText, limit });
}

async function searchKeywordGrantKnowledge({
  searchText,
  limit
}: {
  searchText: string;
  limit: number;
}) {
  const likePattern = `%${searchText}%`;
  const result = await query<GrantKnowledgeSearchRow>(
    `with search_query as (
       select websearch_to_tsquery('english', $1) as query
     )
     select d.id::text,
            d.application_id::text,
            d.document_kind,
            d.title,
            d.applicant_name,
            d.source_kind,
            d.source_id,
            d.source_url,
            d.normalized_status,
            d.requested_amount_usd::text,
            (
              ts_rank_cd(d.search_tsv, search_query.query) +
              case when d.title ilike $2 then 0.35 else 0 end +
              case when d.applicant_name ilike $2 then 0.25 else 0 end +
              case when d.source_id ilike $2 then 0.12 else 0 end
            ) as rank,
            d.content
       from grant_knowledge_documents d
       cross join search_query
      where d.search_tsv @@ search_query.query
         or d.title ilike $2
         or d.applicant_name ilike $2
         or d.source_id ilike $2
         or d.content ilike $2
      order by rank desc, d.indexed_at desc
      limit $3`,
    [searchText, likePattern, limit]
  );

  return result.rows.map((row) => mapSearchRow(row, searchText));
}

async function searchSemanticGrantKnowledge({
  searchText,
  limit
}: {
  searchText: string;
  limit: number;
}) {
  const embedding = await createQueryEmbedding(searchText);
  const result = await query<GrantKnowledgeSearchRow>(
    `select d.id::text,
            d.application_id::text,
            d.document_kind,
            d.title,
            d.applicant_name,
            d.source_kind,
            d.source_id,
            d.source_url,
            d.normalized_status,
            d.requested_amount_usd::text,
            (1 - (d.embedding <=> ($1)::vector)) as rank,
            d.content
       from grant_knowledge_documents d
      where d.embedding is not null
        and d.embedding_model = $2
        and d.embedding_dims = $3
        and d.embedding_content_hash = d.content_hash
      order by d.embedding <=> ($1)::vector
      limit $4`,
    [vectorLiteral(embedding), knowledgeEmbeddingModel(), knowledgeEmbeddingDims(), limit]
  );

  return result.rows.map((row) => mapSearchRow(row, searchText));
}

function normalizeRank(value: number, max: number) {
  if (!Number.isFinite(value) || value <= 0 || max <= 0) {
    return 0;
  }

  return value / max;
}

function searchResultKey(result: GrantKnowledgeSearchResult) {
  return result.id;
}

async function searchHybridGrantKnowledge({
  searchText,
  limit
}: {
  searchText: string;
  limit: number;
}) {
  const expandedLimit = Math.min(60, Math.max(limit * 4, limit));
  const [keywordResults, semanticResults] = await Promise.all([
    searchKeywordGrantKnowledge({ searchText, limit: expandedLimit }),
    searchSemanticGrantKnowledge({ searchText, limit: expandedLimit })
  ]);
  const maxKeywordRank = Math.max(...keywordResults.map((result) => result.rank), 0);
  const maxSemanticRank = Math.max(...semanticResults.map((result) => result.rank), 0);
  const merged = new Map<
    string,
    {
      result: GrantKnowledgeSearchResult;
      keywordRank: number;
      semanticRank: number;
    }
  >();

  for (const result of keywordResults) {
    merged.set(searchResultKey(result), {
      result,
      keywordRank: result.rank,
      semanticRank: 0
    });
  }

  for (const result of semanticResults) {
    const key = searchResultKey(result);
    const existing = merged.get(key);

    if (existing) {
      existing.semanticRank = result.rank;
      continue;
    }

    merged.set(key, {
      result,
      keywordRank: 0,
      semanticRank: result.rank
    });
  }

  return [...merged.values()]
    .map(({ result, keywordRank, semanticRank }) => {
      const appearsInBoth = keywordRank > 0 && semanticRank > 0;
      const hybridRank =
        normalizeRank(keywordRank, maxKeywordRank) * 0.45 +
        normalizeRank(semanticRank, maxSemanticRank) * 0.55 +
        (appearsInBoth ? 0.08 : 0);

      return {
        ...result,
        rank: hybridRank
      };
    })
    .sort((left, right) => right.rank - left.rank)
    .slice(0, limit);
}

export async function runGrantKnowledgeSearch({
  searchText,
  limit,
  answerMode,
  retrievalMode,
  allowAiAnswer,
  allowSemanticSearch,
  principalId
}: {
  searchText: string;
  limit: number;
  answerMode: KnowledgeAnswerMode;
  retrievalMode: KnowledgeRetrievalMode;
  allowAiAnswer: boolean;
  allowSemanticSearch: boolean;
  principalId?: string | null;
}): Promise<GrantKnowledgeSearchResponse> {
  const effectiveRetrievalMode = allowSemanticSearch ? retrievalMode : "keyword";
  const results = await searchGrantKnowledge({
    searchText,
    limit,
    retrievalMode: effectiveRetrievalMode
  });
  const providerStatus = knowledgeProviderStatus();
  let answerText: string | null = null;
  let answerStatus: GrantKnowledgeSearchResponse["answerStatus"] = "not_requested";

  if (answerMode === "ai") {
    if (allowAiAnswer && knowledgeAiEnabled()) {
      answerText = await composeGrantKnowledgeAnswer({ searchText, results });
      answerStatus = "generated";
    } else {
      answerText = extractiveAnswer(searchText, results);
      answerStatus = "disabled";
    }
  } else {
    answerText = extractiveAnswer(searchText, results);
    answerStatus = "evidence";
  }

  if (principalId) {
    await recordAuditEvent({
      actorPrincipalId: principalId,
      action: "knowledge.search",
      targetType: "grant_knowledge",
      targetId: null,
      metadata: {
        query: searchText,
        limit,
        answerMode,
        retrievalMode: effectiveRetrievalMode,
        answerStatus,
        resultCount: results.length
      }
    });

    await query(
      `insert into grant_knowledge_queries (
         principal_id,
         query_text,
         retrieval_mode,
         result_count,
         answer_mode,
         metadata
       )
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        principalId,
        searchText,
        effectiveRetrievalMode === "keyword" ? "postgres_full_text" : effectiveRetrievalMode,
        results.length,
        answerMode,
        JSON.stringify({
          answerStatus,
          retrievalMode: effectiveRetrievalMode,
          provider: providerStatus.aiConfigured ? "configured" : "not_configured"
        })
      ]
    );
  }

  return {
    ok: true,
    query: searchText,
    answerMode,
    retrievalMode: effectiveRetrievalMode,
    answerText,
    answerStatus,
    results,
    retrievalStats: {
      resultCount: results.length,
      limit,
      mode: effectiveRetrievalMode,
      semanticSearchEnabled: providerStatus.semanticSearchEnabled
    },
    providerStatus
  };
}
