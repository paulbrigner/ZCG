import { query } from "@/lib/db";
import type {
  GrantKnowledgeSearchResponse,
  KnowledgeAnswerMode,
  KnowledgeRetrievalMode
} from "@/lib/knowledge/search";

export type GrantKnowledgeAnswerJobStatus = "queued" | "running" | "succeeded" | "failed" | "expired";

export type GrantKnowledgeAnswerJobRequest = {
  searchText: string;
  limit: number;
  answerMode: KnowledgeAnswerMode;
  retrievalMode: KnowledgeRetrievalMode;
  allowAiAnswer: boolean;
  allowSemanticSearch: boolean;
};

export type GrantKnowledgeAnswerJob = {
  id: string;
  principalId: string | null;
  status: GrantKnowledgeAnswerJobStatus;
  queryText: string;
  retrievalMode: KnowledgeRetrievalMode;
  answerMode: KnowledgeAnswerMode;
  limit: number;
  request: GrantKnowledgeAnswerJobRequest;
  result: GrantKnowledgeSearchResponse | null;
  errorMessage: string | null;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
};

type GrantKnowledgeAnswerJobRow = {
  id: string;
  principal_id: string | null;
  status: GrantKnowledgeAnswerJobStatus;
  query_text: string;
  retrieval_mode: KnowledgeRetrievalMode;
  answer_mode: KnowledgeAnswerMode;
  limit_value: number | string;
  request_payload: string | Record<string, unknown>;
  result_payload: string | Record<string, unknown> | null;
  error_message: string | null;
  attempt_count: number | string;
  max_attempts: number | string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string;
};

function parseJsonRecord(value: string | Record<string, unknown> | null): Record<string, unknown> {
  if (!value) {
    return {};
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseSearchResponse(value: string | Record<string, unknown> | null) {
  const parsed = parseJsonRecord(value);
  return parsed.ok === true ? (parsed as GrantKnowledgeSearchResponse) : null;
}

function numberValue(value: number | string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapJobRow(row: GrantKnowledgeAnswerJobRow): GrantKnowledgeAnswerJob {
  return {
    id: row.id,
    principalId: row.principal_id,
    status: row.status,
    queryText: row.query_text,
    retrievalMode: row.retrieval_mode,
    answerMode: row.answer_mode,
    limit: numberValue(row.limit_value),
    request: parseJsonRecord(row.request_payload) as GrantKnowledgeAnswerJobRequest,
    result: parseSearchResponse(row.result_payload),
    errorMessage: row.error_message,
    attemptCount: numberValue(row.attempt_count),
    maxAttempts: numberValue(row.max_attempts),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at
  };
}

export function serializeGrantKnowledgeAnswerJob(job: GrantKnowledgeAnswerJob) {
  return {
    jobId: job.id,
    status: job.status,
    result: job.result,
    error: job.errorMessage ? { message: job.errorMessage } : null,
    pollAfterMs: job.status === "queued" || job.status === "running" ? 1500 : 0,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    expiresAt: job.expiresAt
  };
}

export async function createGrantKnowledgeAnswerJob({
  principalId,
  request
}: {
  principalId: string | null;
  request: GrantKnowledgeAnswerJobRequest;
}) {
  const result = await query<GrantKnowledgeAnswerJobRow>(
    `insert into grant_knowledge_answer_jobs (
       principal_id,
       status,
       query_text,
       retrieval_mode,
       answer_mode,
       limit_value,
       request_payload
     )
     values ($1, 'queued', $2, $3, $4, $5, $6::jsonb)
     returning id::text,
               principal_id::text,
               status,
               query_text,
               retrieval_mode,
               answer_mode,
               limit_value,
               request_payload::text,
               result_payload::text,
               error_message,
               attempt_count,
               max_attempts,
               created_at::text,
               updated_at::text,
               started_at::text,
               completed_at::text,
               expires_at::text`,
    [
      principalId,
      request.searchText,
      request.retrievalMode,
      request.answerMode,
      request.limit,
      JSON.stringify(request)
    ]
  );

  return mapJobRow(result.rows[0]);
}

export async function getGrantKnowledgeAnswerJob(jobId: string) {
  const result = await query<GrantKnowledgeAnswerJobRow>(
    `select id::text,
            principal_id::text,
            status,
            query_text,
            retrieval_mode,
            answer_mode,
            limit_value,
            request_payload::text,
            result_payload::text,
            error_message,
            attempt_count,
            max_attempts,
            created_at::text,
            updated_at::text,
            started_at::text,
            completed_at::text,
            expires_at::text
       from grant_knowledge_answer_jobs
      where id = $1`,
    [jobId]
  );

  return result.rows[0] ? mapJobRow(result.rows[0]) : null;
}

export async function claimGrantKnowledgeAnswerJob(jobId: string) {
  const result = await query<GrantKnowledgeAnswerJobRow>(
    `update grant_knowledge_answer_jobs
        set status = 'running',
            attempt_count = attempt_count + 1,
            started_at = coalesce(started_at, now()),
            updated_at = now(),
            error_message = null
      where id = $1
        and status = 'queued'
        and expires_at > now()
      returning id::text,
                principal_id::text,
                status,
                query_text,
                retrieval_mode,
                answer_mode,
                limit_value,
                request_payload::text,
                result_payload::text,
                error_message,
                attempt_count,
                max_attempts,
                created_at::text,
                updated_at::text,
                started_at::text,
                completed_at::text,
                expires_at::text`,
    [jobId]
  );

  return result.rows[0] ? mapJobRow(result.rows[0]) : null;
}

export async function completeGrantKnowledgeAnswerJob(jobId: string, response: GrantKnowledgeSearchResponse) {
  await query(
    `update grant_knowledge_answer_jobs
        set status = 'succeeded',
            result_payload = $2::jsonb,
            error_message = null,
            completed_at = now(),
            updated_at = now()
      where id = $1`,
    [jobId, JSON.stringify(response)]
  );
}

export async function failGrantKnowledgeAnswerJob(jobId: string, message: string) {
  await query(
    `update grant_knowledge_answer_jobs
        set status = case when expires_at <= now() then 'expired' else 'failed' end,
            error_message = $2,
            completed_at = now(),
            updated_at = now()
      where id = $1`,
    [jobId, message]
  );
}
