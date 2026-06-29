import { query } from "@/lib/db";

export type SyncRunRow = {
  id: string;
  source: string;
  status: string;
  records_seen: string;
  records_created: string;
  records_updated: string;
  records_skipped: string;
  error_summary: string | null;
  started_at: string;
  completed_at: string | null;
};

export type SourceCountRow = {
  source_kind: string;
  record_count: string;
  latest_updated_at: string | null;
};

export type ReconciliationSummaryRow = {
  status: string;
  severity: string;
  issue_count: string;
};

export type GrantApplicationRow = {
  id: string;
  title: string;
  applicant_name: string | null;
  normalized_status: string;
  requested_amount_usd: string | null;
  match_confidence: string;
  github_issue_number: string | null;
  github_issue_url: string | null;
  source_count: string;
  open_issue_count: string;
  updated_at: string;
};

export type SourceEvidenceRow = {
  id: string;
  source_kind: string;
  source_id: string;
  source_url: string | null;
  title: string | null;
  summary: string | null;
  confidence: string;
  raw_payload: string;
  metadata: string;
};

export type ReconciliationIssueRow = {
  id: string;
  issue_type: string;
  severity: string;
  status: string;
  summary: string;
  details: string;
  created_at: string;
};

export async function getAdminDashboard() {
  const [syncRuns, sourceCounts, reconciliationSummary, applications] = await Promise.all([
    query<SyncRunRow>(
      `select id,
              source,
              status,
              records_seen::text,
              records_created::text,
              records_updated::text,
              records_skipped::text,
              error_summary,
              started_at::text,
              completed_at::text
         from sync_runs
        order by started_at desc
        limit 8`
    ),
    query<SourceCountRow>(
      `select source_kind,
              count(*)::text as record_count,
              max(updated_at)::text as latest_updated_at
         from source_records
        group by source_kind
        order by source_kind`
    ),
    query<ReconciliationSummaryRow>(
      `select status,
              severity,
              count(*)::text as issue_count
         from reconciliation_issues
        group by status, severity
        order by status, severity`
    ),
    query<GrantApplicationRow>(
      `select ga.id::text,
              ga.title,
              ga.applicant_name,
              ga.normalized_status,
              ga.requested_amount_usd::text,
              ga.match_confidence::text,
              ga.github_issue_number::text,
              ga.github_issue_url,
              count(distinct sl.source_record_id)::text as source_count,
              count(distinct ri.id) filter (where ri.status = 'open')::text as open_issue_count,
              ga.updated_at::text
         from grant_applications ga
         left join source_links sl on sl.canonical_type = 'grant_application'
                                  and sl.canonical_id = ga.id
         left join reconciliation_issues ri on ri.canonical_type = 'grant_application'
                                           and ri.canonical_id = ga.id
        group by ga.id
        order by ga.updated_at desc
        limit 20`
    )
  ]);

  return {
    syncRuns: syncRuns.rows,
    sourceCounts: sourceCounts.rows,
    reconciliationSummary: reconciliationSummary.rows,
    applications: applications.rows
  };
}

export async function getGrantApplicationDetail(id: string) {
  const [application, sources, issues] = await Promise.all([
    query<GrantApplicationRow>(
      `select ga.id::text,
              ga.title,
              ga.applicant_name,
              ga.normalized_status,
              ga.requested_amount_usd::text,
              ga.match_confidence::text,
              ga.github_issue_number::text,
              ga.github_issue_url,
              count(distinct sl.source_record_id)::text as source_count,
              count(distinct ri.id) filter (where ri.status = 'open')::text as open_issue_count,
              ga.updated_at::text
         from grant_applications ga
         left join source_links sl on sl.canonical_type = 'grant_application'
                                  and sl.canonical_id = ga.id
         left join reconciliation_issues ri on ri.canonical_type = 'grant_application'
                                           and ri.canonical_id = ga.id
        where ga.id = $1
        group by ga.id`,
      [id]
    ),
    query<SourceEvidenceRow>(
      `select sr.id::text,
              sr.source_kind,
              sr.source_id,
              sr.source_url,
              sr.title,
              sr.summary,
              sl.confidence::text,
              sr.raw_payload::text,
              sr.metadata::text
         from source_links sl
         join source_records sr on sr.id = sl.source_record_id
        where sl.canonical_type = 'grant_application'
          and sl.canonical_id = $1
        order by sr.source_kind, sl.confidence desc, sr.source_id`,
      [id]
    ),
    query<ReconciliationIssueRow>(
      `select id::text,
              issue_type,
              severity,
              status,
              summary,
              details::text,
              created_at::text
         from reconciliation_issues
        where canonical_type = 'grant_application'
          and canonical_id = $1
        order by status, severity desc, created_at desc`,
      [id]
    )
  ]);

  return {
    application: application.rows[0] ?? null,
    sources: sources.rows,
    issues: issues.rows
  };
}
