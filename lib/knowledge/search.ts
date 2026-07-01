import { query } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { knowledgeAiEnabled, knowledgeProviderStatus } from "@/lib/knowledge/config";
import { composeGrantKnowledgeAnswer } from "@/lib/knowledge/compose";

export type KnowledgeAnswerMode = "evidence" | "ai";

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

export type GrantKnowledgeOverview = {
  documentCount: number;
  applicationCount: number;
  latestIndexedAt: string | null;
  sourceKinds: Array<{ sourceKind: string; documentCount: number }>;
};

export type GrantKnowledgeSearchResponse = {
  ok: true;
  query: string;
  answerMode: KnowledgeAnswerMode;
  answerText: string | null;
  answerStatus: "evidence" | "generated" | "disabled" | "not_requested";
  results: GrantKnowledgeSearchResult[];
  retrievalStats: {
    resultCount: number;
    limit: number;
    semanticSearchEnabled: boolean;
  };
  providerStatus: ReturnType<typeof knowledgeProviderStatus>;
};

const defaultLimit = 8;
const maxLimit = 20;

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
  const [overview, sourceKinds] = await Promise.all([
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
    )
  ]);
  const row = overview.rows[0];

  return {
    documentCount: Number(row?.document_count ?? 0),
    applicationCount: Number(row?.application_count ?? 0),
    latestIndexedAt: row?.latest_indexed_at ?? null,
    sourceKinds: sourceKinds.rows.map((sourceKind) => ({
      sourceKind: sourceKind.source_kind,
      documentCount: Number(sourceKind.document_count)
    }))
  };
}

export async function searchGrantKnowledge({
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

export async function runGrantKnowledgeSearch({
  searchText,
  limit,
  answerMode,
  allowAiAnswer,
  principalId
}: {
  searchText: string;
  limit: number;
  answerMode: KnowledgeAnswerMode;
  allowAiAnswer: boolean;
  principalId?: string | null;
}): Promise<GrantKnowledgeSearchResponse> {
  const results = await searchGrantKnowledge({ searchText, limit });
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
        "postgres_full_text",
        results.length,
        answerMode,
        JSON.stringify({
          answerStatus,
          provider: providerStatus.aiConfigured ? "configured" : "not_configured"
        })
      ]
    );
  }

  return {
    ok: true,
    query: searchText,
    answerMode,
    answerText,
    answerStatus,
    results,
    retrievalStats: {
      resultCount: results.length,
      limit,
      semanticSearchEnabled: providerStatus.semanticSearchEnabled
    },
    providerStatus
  };
}
