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
  answerStatus: "evidence" | "generated" | "fallback" | "disabled" | "not_requested";
  results: GrantKnowledgeSearchResult[];
  retrievalStats: {
    resultCount: number;
    initialResultCount: number;
    expandedEvidenceCount: number;
    candidateResultCount: number;
    limit: number;
    mode: KnowledgeRetrievalMode;
    semanticSearchEnabled: boolean;
  };
  providerStatus: ReturnType<typeof knowledgeProviderStatus>;
};

const defaultLimit = 8;
const maxLimit = 20;
const maxAnswerEvidenceApplications = 5;
const maxAnswerCandidateDocuments = 100;
const maxAnswerCandidateApplications = 90;
const maxAnswerEvidenceDocuments = 100;
const maxExpandedDocumentsPerApplication = 7;
const maxExpandedSourceDocuments = 20;
const maxInitialEvidenceDocuments = 8;
const searchResultContentMaxChars = 6000;
const clientResultContentMaxChars = 1200;

function boundedContentSql(tableAlias: string) {
  return `left(${tableAlias}.content, ${searchResultContentMaxChars})`;
}

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

function truncateClientContent(content: string) {
  if (content.length <= clientResultContentMaxChars) {
    return content;
  }

  return `${content.slice(0, clientResultContentMaxChars - 80)}\n\n[Content truncated in API response.]`;
}

function resultForClient(result: GrantKnowledgeSearchResult): GrantKnowledgeSearchResult {
  return {
    ...result,
    content: truncateClientContent(result.content)
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

function aiFallbackAnswer(searchText: string, results: GrantKnowledgeSearchResult[]) {
  return [
    "The AI grounded answer did not complete within the live request budget. Showing grounded evidence instead.",
    "",
    extractiveAnswer(searchText, results)
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
            ${boundedContentSql("d")} as content
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
            ${boundedContentSql("d")} as content
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

function uniqueApplicationMatches(results: GrantKnowledgeSearchResult[], maxApplications = maxAnswerEvidenceApplications) {
  const seen = new Set<string>();
  const matches: Array<{ applicationId: string; appOrder: number; appRank: number }> = [];

  for (const result of results) {
    if (seen.has(result.applicationId)) {
      continue;
    }

    seen.add(result.applicationId);
    matches.push({
      applicationId: result.applicationId,
      appOrder: matches.length,
      appRank: Number.isFinite(result.rank) ? result.rank : 0
    });

    if (matches.length >= maxApplications) {
      break;
    }
  }

  return matches;
}

async function fetchCandidateApplicationSummaries({
  searchText,
  results,
  maxApplications
}: {
  searchText: string;
  results: GrantKnowledgeSearchResult[];
  maxApplications: number;
}) {
  const applicationMatches = uniqueApplicationMatches(results, maxApplications);

  if (!applicationMatches.length) {
    return [];
  }

  const result = await query<GrantKnowledgeSearchRow>(
    `with selected as (
       select application_id,
              app_order,
              app_rank
         from jsonb_to_recordset($1::jsonb) as x(
           application_id uuid,
           app_order integer,
           app_rank numeric
         )
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
            selected.app_rank as rank,
            ${boundedContentSql("d")} as content
       from selected
       join grant_knowledge_documents d on d.application_id = selected.application_id
                                      and d.document_kind = 'application_summary'
      order by selected.app_order
      limit $2`,
    [JSON.stringify(applicationMatches), maxApplications]
  );

  return result.rows.map((row) => mapSearchRow(row, searchText));
}

function mergeAnswerEvidence({
  initialResults,
  expandedSourceResults,
  candidateSummaryResults,
  maxDocuments
}: {
  initialResults: GrantKnowledgeSearchResult[];
  expandedSourceResults: GrantKnowledgeSearchResult[];
  candidateSummaryResults: GrantKnowledgeSearchResult[];
  maxDocuments: number;
}) {
  const merged = new Map<string, GrantKnowledgeSearchResult>();

  for (const result of initialResults.slice(0, maxInitialEvidenceDocuments)) {
    merged.set(result.id, result);
  }

  for (const result of candidateSummaryResults) {
    if (!merged.has(result.id)) {
      merged.set(result.id, result);
    }
  }

  for (const result of expandedSourceResults) {
    if (!merged.has(result.id)) {
      merged.set(result.id, result);
    }
  }

  return [...merged.values()].slice(0, maxDocuments);
}

async function buildAnswerEvidenceResults({
  searchText,
  initialResults,
  candidateResults
}: {
  searchText: string;
  initialResults: GrantKnowledgeSearchResult[];
  candidateResults: GrantKnowledgeSearchResult[];
}) {
  const [expandedSourceResults, candidateSummaryResults] = await Promise.all([
    expandResultsWithApplicationSources({
      searchText,
      results: initialResults,
      maxDocuments: maxExpandedSourceDocuments
    }),
    fetchCandidateApplicationSummaries({
      searchText,
      results: candidateResults,
      maxApplications: maxAnswerCandidateApplications
    })
  ]);

  return mergeAnswerEvidence({
    initialResults,
    expandedSourceResults,
    candidateSummaryResults,
    maxDocuments: maxAnswerEvidenceDocuments
  });
}

async function expandResultsWithApplicationSources({
  searchText,
  results,
  maxDocuments
}: {
  searchText: string;
  results: GrantKnowledgeSearchResult[];
  maxDocuments: number;
}) {
  if (!results.length) {
    return results;
  }

  const applicationMatches = uniqueApplicationMatches(results);

  if (!applicationMatches.length) {
    return results;
  }

  const result = await query<GrantKnowledgeSearchRow>(
    `with selected as (
       select application_id,
              app_order,
              app_rank
         from jsonb_to_recordset($1::jsonb) as x(
           application_id uuid,
           app_order integer,
           app_rank numeric
         )
     ),
     ranked as (
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
              ${boundedContentSql("d")} as content,
              selected.app_order,
              selected.app_rank,
              row_number() over (
                partition by d.application_id
                order by
                  case
                    when d.document_kind = 'application_summary' then 0
                    when d.document_kind = 'github_issue' then 1
                    when d.document_kind = 'google_sheet_row' then 2
                    when d.document_kind = 'decision_minutes' then 3
                    when d.document_kind = 'github_issue_comment' then 4
                    when d.document_kind = 'forum_link' then 5
                    else 9
                  end,
                  d.indexed_at desc,
                  d.source_kind,
                  d.source_id
              ) as source_rank
         from selected
         join grant_knowledge_documents d on d.application_id = selected.application_id
     )
     select id,
            application_id,
            document_kind,
            title,
            applicant_name,
            source_kind,
            source_id,
            source_url,
            normalized_status,
            requested_amount_usd,
            greatest(app_rank - (source_rank::numeric * 0.0001), 0) as rank,
            content
       from ranked
      where source_rank <= $2
      order by app_order, source_rank
      limit $3`,
    [JSON.stringify(applicationMatches), maxExpandedDocumentsPerApplication, maxDocuments]
  );
  const expanded = result.rows.map((row) => mapSearchRow(row, searchText));
  const merged = new Map<string, GrantKnowledgeSearchResult>();
  const initialEvidenceCap = Math.min(results.length, Math.max(defaultLimit, Math.ceil(maxDocuments / 2)));

  for (const result of results.slice(0, initialEvidenceCap)) {
    merged.set(result.id, result);
  }

  for (const result of expanded) {
    if (!merged.has(result.id)) {
      merged.set(result.id, result);
    }
  }

  return [...merged.values()].slice(0, maxDocuments);
}

async function searchHybridGrantKnowledge({
  searchText,
  limit
}: {
  searchText: string;
  limit: number;
}) {
  const expandedLimit = Math.min(60, Math.max(limit * 4, limit));
  const [keywordOutcome, semanticOutcome] = await Promise.allSettled([
    searchKeywordGrantKnowledge({ searchText, limit: expandedLimit }),
    searchSemanticGrantKnowledge({ searchText, limit: expandedLimit })
  ]);

  if (keywordOutcome.status === "rejected") {
    throw keywordOutcome.reason;
  }

  const keywordResults = keywordOutcome.value;

  if (semanticOutcome.status === "rejected") {
    console.error("Grant knowledge semantic retrieval failed; falling back to keyword retrieval", semanticOutcome.reason);
    return keywordResults.slice(0, limit);
  }

  const semanticResults = semanticOutcome.value;
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
  const shouldGenerateAiAnswer = answerMode === "ai" && allowAiAnswer && knowledgeAiEnabled();
  const candidateLimit = shouldGenerateAiAnswer ? maxAnswerCandidateDocuments : limit;
  const candidateResults = await searchGrantKnowledge({
    searchText,
    limit: candidateLimit,
    retrievalMode: effectiveRetrievalMode
  });
  const results = shouldGenerateAiAnswer ? candidateResults.slice(0, limit) : candidateResults;
  let answerEvidenceResults = results;
  const providerStatus = knowledgeProviderStatus();
  let answerText: string | null = null;
  let answerStatus: GrantKnowledgeSearchResponse["answerStatus"] = "not_requested";

  if (answerMode === "ai") {
    if (shouldGenerateAiAnswer) {
      answerEvidenceResults = await buildAnswerEvidenceResults({
        searchText,
        initialResults: results,
        candidateResults
      });
      try {
        answerText = await composeGrantKnowledgeAnswer({ searchText, results: answerEvidenceResults });
        answerStatus = "generated";
      } catch (error) {
        console.error("Grant knowledge answer generation failed", error);
        answerText = aiFallbackAnswer(searchText, answerEvidenceResults);
        answerStatus = "fallback";
      }
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
        resultCount: answerEvidenceResults.length,
        initialResultCount: results.length,
        expandedEvidenceCount: answerEvidenceResults.length,
        candidateResultCount: candidateResults.length
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
          initialResultCount: results.length,
          expandedEvidenceCount: answerEvidenceResults.length,
          candidateResultCount: candidateResults.length,
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
    results: answerEvidenceResults.map(resultForClient),
    retrievalStats: {
      resultCount: answerEvidenceResults.length,
      initialResultCount: results.length,
      expandedEvidenceCount: answerEvidenceResults.length,
      candidateResultCount: candidateResults.length,
      limit,
      mode: effectiveRetrievalMode,
      semanticSearchEnabled: providerStatus.semanticSearchEnabled
    },
    providerStatus
  };
}
