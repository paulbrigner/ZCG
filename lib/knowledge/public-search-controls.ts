import { createHmac } from "node:crypto";
import { query } from "@/lib/db";
import {
  publicKnowledgeSemanticDailyLimit,
  publicKnowledgeSemanticPerClientMinuteLimit
} from "@/lib/knowledge/config";
import type { KnowledgeRetrievalMode } from "@/lib/knowledge/search";

export type PublicKnowledgeSearchOutcome =
  | "served"
  | "rate_limited_fallback"
  | "control_unavailable_fallback"
  | "provider_error_fallback"
  | "error";

export type PublicKnowledgeSearchTelemetryRow = {
  usageDate: string;
  requestedMode: KnowledgeRetrievalMode;
  servedMode: KnowledgeRetrievalMode;
  outcome: PublicKnowledgeSearchOutcome;
  requestCount: number;
  lastSeenAt: string;
};

export type PublicSemanticSearchAllowance = {
  allowed: boolean;
  reason: "client" | "global" | null;
};

export type PublicKnowledgeSearchControlStatus = {
  perClientMinuteLimit: number;
  dailyLimit: number;
  dailySemanticRequests: number;
};

type QueryExecutorResult = {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
};

export type PublicSearchQueryExecutor = (
  sql: string,
  values?: readonly unknown[]
) => Promise<QueryExecutorResult>;

type AllowanceRow = {
  client_allowed?: unknown;
  global_allowed?: unknown;
};

type TelemetryRow = {
  usage_date?: unknown;
  requested_mode?: unknown;
  served_mode?: unknown;
  outcome?: unknown;
  request_count?: unknown;
  last_seen_at?: unknown;
};

const defaultQueryExecutor: PublicSearchQueryExecutor = async (sql, values = []) => {
  const result = await query<Record<string, unknown>>(sql, values);
  return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
};

function headerValue(headers: Headers, name: string) {
  const value = headers.get(name)?.trim();
  return value || null;
}

function publicClientAddress(headers: Headers) {
  // Trusted reverse proxies append the observed client address, so use the last
  // forwarded value instead of a potentially client-supplied prefix.
  const forwardedFor = headerValue(headers, "x-forwarded-for")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);

  return (
    forwardedFor ||
    headerValue(headers, "cf-connecting-ip") ||
    headerValue(headers, "x-real-ip") ||
    "unknown"
  );
}

function publicClientHashSecret() {
  return (
    process.env.ZCG_PUBLIC_SEARCH_HASH_SECRET?.trim() ||
    process.env.BETTER_AUTH_SECRET?.trim() ||
    process.env.WORKER_SHARED_SECRET?.trim() ||
    "zcg-public-search-local-development"
  );
}

export function publicKnowledgeSearchClientHash(
  headers: Headers,
  secret = publicClientHashSecret()
) {
  return createHmac("sha256", secret)
    .update(`public-knowledge-search:${publicClientAddress(headers)}`)
    .digest("hex");
}

function minuteWindowStart(now: Date) {
  const windowStart = new Date(now);
  windowStart.setUTCSeconds(0, 0);
  return windowStart.toISOString();
}

function dayWindowStart(now: Date) {
  const windowStart = new Date(now);
  windowStart.setUTCHours(0, 0, 0, 0);
  return windowStart.toISOString();
}

function booleanValue(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function allowanceFromRow(row: AllowanceRow | undefined): PublicSemanticSearchAllowance {
  const clientAllowed = booleanValue(row?.client_allowed);
  const globalAllowed = booleanValue(row?.global_allowed);

  if (!clientAllowed) {
    return { allowed: false, reason: "client" };
  }

  if (!globalAllowed) {
    return { allowed: false, reason: "global" };
  }

  return { allowed: true, reason: null };
}

export async function consumePublicSemanticSearchAllowance({
  clientHash,
  now = new Date(),
  queryExecutor = defaultQueryExecutor
}: {
  clientHash: string;
  now?: Date;
  queryExecutor?: PublicSearchQueryExecutor;
}): Promise<PublicSemanticSearchAllowance> {
  const result = await queryExecutor(
    `with expired as (
       delete from public_knowledge_search_rate_limits
        where window_start < now() - interval '2 days'
     ),
     client_allowance as (
       insert into public_knowledge_search_rate_limits (
         scope,
         scope_key,
         window_start,
         request_count,
         updated_at
       )
       values ('client_minute', $1, $2::timestamptz, 1, now())
       on conflict (scope, scope_key, window_start) do update
         set request_count = public_knowledge_search_rate_limits.request_count + 1,
             updated_at = now()
       where public_knowledge_search_rate_limits.request_count < $3::integer
       returning request_count
     ),
     global_allowance as (
       insert into public_knowledge_search_rate_limits (
         scope,
         scope_key,
         window_start,
         request_count,
         updated_at
       )
       select 'global_day', 'global', $4::timestamptz, 1, now()
        where exists (select 1 from client_allowance)
       on conflict (scope, scope_key, window_start) do update
         set request_count = public_knowledge_search_rate_limits.request_count + 1,
             updated_at = now()
       where public_knowledge_search_rate_limits.request_count < $5::integer
       returning request_count
     )
     select exists (select 1 from client_allowance) as client_allowed,
            exists (select 1 from global_allowance) as global_allowed`,
    [
      clientHash,
      minuteWindowStart(now),
      publicKnowledgeSemanticPerClientMinuteLimit(),
      dayWindowStart(now),
      publicKnowledgeSemanticDailyLimit()
    ]
  );

  return allowanceFromRow(result.rows[0] as AllowanceRow | undefined);
}

export async function recordPublicKnowledgeSearchTelemetry({
  requestedMode,
  servedMode,
  outcome,
  queryExecutor = defaultQueryExecutor
}: {
  requestedMode: KnowledgeRetrievalMode;
  servedMode: KnowledgeRetrievalMode;
  outcome: PublicKnowledgeSearchOutcome;
  queryExecutor?: PublicSearchQueryExecutor;
}) {
  try {
    await queryExecutor(
      `insert into public_knowledge_search_telemetry (
         usage_date,
         requested_mode,
         served_mode,
         outcome,
         request_count,
         last_seen_at
       )
       values ((now() at time zone 'UTC')::date, $1, $2, $3, 1, now())
       on conflict (usage_date, requested_mode, served_mode, outcome) do update
         set request_count = public_knowledge_search_telemetry.request_count + 1,
             last_seen_at = now()`,
      [requestedMode, servedMode, outcome]
    );
  } catch (error) {
    console.error("Could not record aggregate public knowledge search telemetry", error);
  }
}

export async function getPublicKnowledgeSearchTelemetry({
  days = 14,
  queryExecutor = defaultQueryExecutor
}: {
  days?: number;
  queryExecutor?: PublicSearchQueryExecutor;
} = {}): Promise<PublicKnowledgeSearchTelemetryRow[]> {
  const boundedDays = Math.min(Math.max(Math.trunc(days), 1), 90);
  const result = await queryExecutor(
    `select usage_date::text,
            requested_mode,
            served_mode,
            outcome,
            request_count::text,
            last_seen_at::text
       from public_knowledge_search_telemetry
      where usage_date >= (now() at time zone 'UTC')::date - (($1::integer - 1) * interval '1 day')
      order by usage_date desc, requested_mode, served_mode, outcome`,
    [boundedDays]
  );

  return result.rows.map((rawRow) => {
    const row = rawRow as TelemetryRow;
    return {
      usageDate: String(row.usage_date ?? ""),
      requestedMode: String(row.requested_mode ?? "keyword") as KnowledgeRetrievalMode,
      servedMode: String(row.served_mode ?? "keyword") as KnowledgeRetrievalMode,
      outcome: String(row.outcome ?? "served") as PublicKnowledgeSearchOutcome,
      requestCount: Number(row.request_count ?? 0),
      lastSeenAt: String(row.last_seen_at ?? "")
    };
  });
}

export async function getPublicKnowledgeSearchControlStatus({
  queryExecutor = defaultQueryExecutor
}: {
  queryExecutor?: PublicSearchQueryExecutor;
} = {}): Promise<PublicKnowledgeSearchControlStatus> {
  const result = await queryExecutor(
    `select request_count::text
       from public_knowledge_search_rate_limits
      where scope = 'global_day'
        and scope_key = 'global'
        and window_start = date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
      limit 1`
  );

  return {
    perClientMinuteLimit: publicKnowledgeSemanticPerClientMinuteLimit(),
    dailyLimit: publicKnowledgeSemanticDailyLimit(),
    dailySemanticRequests: Number(result.rows[0]?.request_count ?? 0)
  };
}

export const publicSearchControlTestHooks = {
  allowanceFromRow,
  dayWindowStart,
  minuteWindowStart,
  publicClientAddress
};
