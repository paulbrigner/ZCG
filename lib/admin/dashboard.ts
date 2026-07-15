import { query } from "@/lib/db";

export const applicationFilters = ["all", "matched", "github_only", "sheet_only", "needs_review"] as const;
export const githubIssueStates = ["open", "closed", "none"] as const;
export const applicationSorts = ["oldest", "newest", "funding_desc", "funding_asc", "title"] as const;
export const worklistSortDirections = ["asc", "desc"] as const;
const applicationPageSize = 20;

export type ApplicationFilter = (typeof applicationFilters)[number];
export type GitHubIssueStateFilter = (typeof githubIssueStates)[number];
export type ApplicationSort = (typeof applicationSorts)[number];
export type WorklistSortDirection = (typeof worklistSortDirections)[number];

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

export type ApplicationTotalsRow = {
  total_applications: string;
  total_grants: string;
  matched_applications: string;
  github_only_applications: string;
  sheet_only_applications: string;
  needs_review_applications: string;
};

export type ForumRoleTotalsRow = {
  primary_forum_threads: string;
  supporting_forum_references: string;
};

export type ApplicationPagination = {
  page: number;
  pageSize: number;
  totalResults: string;
  totalPages: number;
  search: string;
  status: string;
  githubIssueState: string;
  labels: string[];
  excludedLabels: string[];
  sort: ApplicationSort;
};

export type ApplicationStatusOptionRow = {
  normalized_status: string;
  application_count: string;
};

export type ApplicationLabelOptionRow = {
  label_name: string;
  label_slug: string;
  label_color: string | null;
  label_category: string;
  label_status: string | null;
  application_count: string;
};

export type GitHubIssueStateOptionRow = {
  github_issue_state: GitHubIssueStateFilter;
  application_count: string;
};

export type GrantApplicationRow = {
  id: string;
  title: string;
  applicant_name: string | null;
  normalized_status: string;
  requested_amount_usd: string | null;
  match_confidence: string;
  source_profile: "matched" | "github_only" | "sheet_github_linked" | "sheet_only" | "unknown";
  github_issue_number: string | null;
  github_issue_url: string | null;
  github_state: string | null;
  source_count: string;
  forum_link_count: string;
  primary_forum_thread_count: string;
  supporting_forum_reference_count: string;
  decision_mention_count: string;
  github_label_count: string;
  github_labels: string;
  open_issue_count: string;
  updated_at: string;
};

export type GrantApplicationListRow = {
  id: string;
  title: string;
  applicant_name: string | null;
  normalized_status: string;
  requested_amount_usd: string | null;
  approved_amount_usd: string | null;
  github_issue_number: string | null;
  github_issue_url: string | null;
  primary_forum_url: string | null;
  github_labels: string;
  submitted_at: string | null;
  submitted_basis: "status_event" | "github_created" | "record_added" | null;
  submitted_provenance: "exact" | "observed" | "inferred" | null;
  status_effective_at: string | null;
  status_effective_date: string | null;
  status_observed_at: string | null;
  status_provenance: "exact" | "observed" | "inferred" | null;
  status_source_kind: string | null;
  status_event_type: string | null;
  latest_briefing_id: string | null;
  latest_briefing_title: string | null;
  latest_briefing_evidence_status: "current" | "changed" | "unknown" | null;
};

export type UnderReviewApplicationRow = {
  id: string;
  title: string;
  applicant_name: string | null;
  outstanding_since: string;
  outstanding_basis: "github_created_at" | "canonical_created_at";
  days_outstanding: number;
  latest_briefing_id: string | null;
  latest_briefing_title: string | null;
};

export type GrantApplicationHeadingRow = {
  id: string;
  title: string;
  applicant_name: string | null;
};

export type GitHubLabelRow = {
  application_id: string;
  label_name: string;
  label_slug: string;
  label_color: string | null;
  label_description: string | null;
  label_category: string;
  label_status: string | null;
  milestone_number: string | null;
  label_order: string;
  source_url: string | null;
  observed_at: string | null;
};

export type ForumLinkRow = {
  id: string;
  source_id: string;
  source_url: string | null;
  title: string | null;
  summary: string | null;
  confidence: string;
  relationship_role: string;
  metadata: string;
};

export type SourceEvidenceRow = {
  id: string;
  source_kind: string;
  source_id: string;
  source_url: string | null;
  title: string | null;
  summary: string | null;
  confidence: string;
  relationship_role: string;
  raw_payload: string;
  metadata: string;
};

export type DecisionMentionRow = {
  id: string;
  candidate_title: string;
  normalized_decision: string;
  decision_text: string | null;
  rationale_text: string | null;
  speaker_notes: string;
  match_method: string;
  confidence: string;
  review_status: string;
  linked_source_url: string | null;
  meeting_date: string | null;
  meeting_title: string;
  topic_url: string;
  source_record_id: string;
  updated_at: string;
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

export type GrantMilestoneLedgerRow = {
  id: string;
  application_id: string;
  source_record_id: string;
  milestone_label: string;
  milestone_number: string | null;
  milestone_type: "startup_funding" | "numbered" | "named";
  reporting_frequency: string | null;
  category: string | null;
  grantee_name: string | null;
  amount_usd: string | null;
  estimate_text: string | null;
  estimated_at: string | null;
  grant_status: string | null;
  match_confidence: string;
  linkage_method: "exact" | "reviewer_confirmed" | "similarity";
  source_url: string | null;
  source_row_number: string | null;
  paid_at: string | null;
  zec_amount: string | null;
  disbursement_usd_amount: string | null;
  exchange_rate_usd_per_zec: string | null;
  disbursement_source_url: string | null;
};

const sheetCanonicalWhere = "(ga.canonical_key like 'sheet:%' or ga.canonical_key like 'sheet-all-grants:%')";
const matchedApplicationWhere = `(
  (ga.canonical_key like 'github:%' and ga.match_confidence > 0)
  or (${sheetCanonicalWhere} and ga.github_issue_number is not null)
)`;

const applicationFilterWhere: Record<ApplicationFilter, string> = {
  all: "true",
  matched: matchedApplicationWhere,
  github_only: "ga.canonical_key like 'github:%' and ga.match_confidence = 0",
  sheet_only: `${sheetCanonicalWhere} and ga.github_issue_number is null`,
  needs_review: `exists (
    select 1
      from reconciliation_issues ri_filter
     where ri_filter.canonical_type = 'grant_application'
       and ri_filter.canonical_id = ga.id
       and ri_filter.status = 'open'
  )`
};

function sourceProfileSql(alias = "ga") {
  const sheetCanonical = `(${alias}.canonical_key like 'sheet:%' or ${alias}.canonical_key like 'sheet-all-grants:%')`;

  return `case
            when ${alias}.canonical_key like 'github:%' and ${alias}.match_confidence > 0 then 'matched'
            when ${alias}.canonical_key like 'github:%' then 'github_only'
            when ${sheetCanonical} and ${alias}.github_issue_number is not null then 'sheet_github_linked'
            when ${sheetCanonical} then 'sheet_only'
            else 'unknown'
          end`;
}

export function normalizeApplicationFilter(value: string | string[] | undefined): ApplicationFilter {
  const candidate = Array.isArray(value) ? value[0] : value;
  return applicationFilters.includes(candidate as ApplicationFilter) ? (candidate as ApplicationFilter) : "all";
}

export function normalizeApplicationSearch(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return (candidate ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
}

export function normalizeApplicationStatus(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return (candidate ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

export function normalizeGitHubIssueState(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  const normalized = (candidate ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return githubIssueStates.includes(normalized as GitHubIssueStateFilter) ? normalized : "";
}

export function normalizeApplicationLabels(value: string | string[] | undefined) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(
    values
      .map((entry) => entry.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120))
      .filter(Boolean)
  )];
}

export function normalizeApplicationPage(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = Number(candidate);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function normalizeApplicationSort(value: string | string[] | undefined): ApplicationSort {
  const candidate = Array.isArray(value) ? value[0] : value;
  return applicationSorts.includes(candidate as ApplicationSort) ? (candidate as ApplicationSort) : "oldest";
}

export function normalizeWorklistSortDirection(
  value: string | string[] | undefined
): WorklistSortDirection {
  const candidate = Array.isArray(value) ? value[0] : value;
  return worklistSortDirections.includes(candidate as WorklistSortDirection)
    ? (candidate as WorklistSortDirection)
    : "asc";
}

const emptyApplicationTotals: ApplicationTotalsRow = {
  total_applications: "0",
  total_grants: "0",
  matched_applications: "0",
  github_only_applications: "0",
  sheet_only_applications: "0",
  needs_review_applications: "0"
};

function applicationSearchWhere(search: string) {
  if (!search) {
    return { sql: "", values: [] as string[] };
  }

  return {
    sql: `and (
      ga.title ilike $1
      or ga.applicant_name ilike $1
      or ga.normalized_status ilike $1
      or ga.github_issue_number::text = $2
      or ga.github_issue_url ilike $1
      or exists (
        select 1
          from grant_application_github_labels gal_search
         where gal_search.application_id = ga.id
           and (
             gal_search.label_name ilike $1
             or gal_search.label_category ilike $1
             or gal_search.label_status ilike $1
           )
      )
      or exists (
        select 1
          from source_links sl_search
          join source_records sr_search on sr_search.id = sl_search.source_record_id
         where sl_search.canonical_type = 'grant_application'
           and sl_search.canonical_id = ga.id
           and (
             sr_search.source_id ilike $1
             or sr_search.title ilike $1
             or sr_search.summary ilike $1
           )
      )
    )`,
    values: [`%${search}%`, search]
  };
}

function applicationStatusWhere(status: string, parameterIndex: number) {
  if (!status) {
    return { sql: "", values: [] as string[] };
  }

  return {
    sql: `and ga.normalized_status = $${parameterIndex}`,
    values: [status]
  };
}

function githubIssueStateWhere(githubIssueState: string, parameterIndex: number) {
  if (!githubIssueState) {
    return { sql: "", values: [] as string[] };
  }

  if (githubIssueState === "none") {
    return {
      sql: "and ga.github_issue_number is null",
      values: [] as string[]
    };
  }

  return {
    sql: `and ga.github_state = $${parameterIndex}`,
    values: [githubIssueState]
  };
}

function applicationLabelsWhere(labels: string[], excludedLabels: string[], parameterIndex: number) {
  if (!labels.length && !excludedLabels.length) {
    return { sql: "", values: [] as string[] };
  }

  const conditions: string[] = [];
  const values = [...labels, ...excludedLabels];

  if (labels.length) {
    const placeholders = labels.map((_label, index) => `$${parameterIndex + index}`).join(", ");
    conditions.push(`exists (
      select 1
        from grant_application_github_labels gal_filter
       where gal_filter.application_id = ga.id
         and gal_filter.label_slug in (${placeholders})
    )`);
  }

  if (excludedLabels.length) {
    const startIndex = parameterIndex + labels.length;
    const placeholders = excludedLabels.map((_label, index) => `$${startIndex + index}`).join(", ");
    conditions.push(`not exists (
      select 1
        from grant_application_github_labels gal_exclude
       where gal_exclude.application_id = ga.id
         and gal_exclude.label_slug in (${placeholders})
    )`);
  }

  return {
    sql: `and ${conditions.join(" and ")}`,
    values
  };
}

export async function getAdminDashboard({
  applicationFilter = "all",
  applicationPage = 1,
  applicationSearch = "",
  applicationStatus = "",
  githubIssueState = "",
  applicationLabels = [],
  excludedApplicationLabels = [],
  applicationSort = "oldest",
  worklistSortDirection = "asc"
}: {
  applicationFilter?: ApplicationFilter;
  applicationPage?: number;
  applicationSearch?: string;
  applicationStatus?: string;
  githubIssueState?: string;
  applicationLabels?: string[];
  excludedApplicationLabels?: string[];
  applicationSort?: ApplicationSort;
  worklistSortDirection?: WorklistSortDirection;
} = {}) {
  const whereClause = applicationFilterWhere[applicationFilter];
  const search = normalizeApplicationSearch(applicationSearch);
  const status = normalizeApplicationStatus(applicationStatus);
  const issueState = normalizeGitHubIssueState(githubIssueState);
  const excludedLabels = normalizeApplicationLabels(excludedApplicationLabels);
  const labels = normalizeApplicationLabels(applicationLabels).filter((label) => !excludedLabels.includes(label));
  const sort = normalizeApplicationSort(applicationSort);
  const applicationOrderSql: Record<ApplicationSort, string> = {
    oldest: "coalesce(submission_event.submitted_at, github_issue_source.created_at, ga.created_at) asc, ga.title, ga.id",
    newest: "coalesce(submission_event.submitted_at, github_issue_source.created_at, ga.created_at) desc, ga.title, ga.id",
    funding_desc: "coalesce(g.approved_amount_usd, ga.requested_amount_usd, 0) desc, ga.title, ga.id",
    funding_asc: "coalesce(g.approved_amount_usd, ga.requested_amount_usd, 0) asc, ga.title, ga.id",
    title: "lower(ga.title) asc, ga.id"
  };
  const worklistOrder = normalizeWorklistSortDirection(worklistSortDirection);
  const worklistOrderSql = worklistOrder === "desc"
    ? "days_outstanding desc, coalesce(github_issue_source.created_at, ga.created_at) asc, ga.title"
    : "days_outstanding asc, coalesce(github_issue_source.created_at, ga.created_at) desc, ga.title";
  const page = Math.max(1, applicationPage);
  const searchWhere = applicationSearchWhere(search);
  const statusWhere = applicationStatusWhere(status, searchWhere.values.length + 1);
  const issueStateWhere = githubIssueStateWhere(issueState, searchWhere.values.length + statusWhere.values.length + 1);
  const labelWhere = applicationLabelsWhere(
    labels,
    excludedLabels,
    searchWhere.values.length + statusWhere.values.length + issueStateWhere.values.length + 1
  );
  const applicationWhereValues = [...searchWhere.values, ...statusWhere.values, ...issueStateWhere.values, ...labelWhere.values];
  const applicationWhereClause = `${whereClause} ${searchWhere.sql} ${statusWhere.sql} ${issueStateWhere.sql} ${labelWhere.sql}`;
  const applicationLimitParam = applicationWhereValues.length + 1;
  const applicationOffsetParam = applicationWhereValues.length + 2;
  const [
    syncRuns,
    sourceCounts,
    reconciliationSummary,
    forumRoleTotals,
    applicationTotals,
    applicationStatusOptions,
    githubIssueStateOptions,
    applicationLabelOptions,
    underReviewApplications,
    applicationResultCount
  ] =
    await Promise.all([
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
    query<ForumRoleTotalsRow>(
      `select count(distinct sl.id) filter (where sl.relationship_role = 'primary_forum_thread')::text
                as primary_forum_threads,
              count(distinct sl.id) filter (
                where coalesce(sl.relationship_role, 'source_evidence') <> 'primary_forum_thread'
              )::text as supporting_forum_references
         from source_links sl
         join source_records sr on sr.id = sl.source_record_id
        where sl.canonical_type = 'grant_application'
          and sr.source_kind = 'forum_link'`
    ),
    query<ApplicationTotalsRow>(
      `select count(*)::text as total_applications,
              (select count(*)::text
                 from grants g
                 join grant_applications ga_funded on ga_funded.id = g.application_id
                where ga_funded.normalized_status in ('approved', 'active', 'completed')) as total_grants,
              count(*) filter (where ${matchedApplicationWhere})::text
                as matched_applications,
              count(*) filter (where ga.canonical_key like 'github:%' and ga.match_confidence = 0)::text
                as github_only_applications,
              count(*) filter (where ${sheetCanonicalWhere} and ga.github_issue_number is null)::text
                as sheet_only_applications,
              count(*) filter (
                where exists (
                  select 1
                    from reconciliation_issues ri_filter
                   where ri_filter.canonical_type = 'grant_application'
                     and ri_filter.canonical_id = ga.id
                     and ri_filter.status = 'open'
                )
              )::text as needs_review_applications
         from grant_applications ga`
    ),
    query<ApplicationStatusOptionRow>(
      `select normalized_status,
              count(*)::text as application_count
         from grant_applications
        group by normalized_status
        order by case normalized_status
                   when 'submitted' then 10
                   when 'under_review' then 20
                   when 'approved' then 30
                   when 'active' then 40
                   when 'completed' then 50
                   when 'closed' then 60
                   when 'cancelled' then 70
                   when 'declined' then 80
                   when 'unknown' then 90
                   else 100
                 end,
                 normalized_status`
    ),
    query<GitHubIssueStateOptionRow>(
      `select github_issue_state,
              application_count
         from (
               select 'open'::text as github_issue_state,
                      count(*) filter (where github_state = 'open')::text as application_count,
                      10 as sort_order
                 from grant_applications
                union all
               select 'closed'::text as github_issue_state,
                      count(*) filter (where github_state = 'closed')::text as application_count,
                      20 as sort_order
                 from grant_applications
                union all
               select 'none'::text as github_issue_state,
                      count(*) filter (where github_issue_number is null)::text as application_count,
                      30 as sort_order
                 from grant_applications
              ) options
        order by sort_order`
    ),
    query<ApplicationLabelOptionRow>(
      `select label_name,
              label_slug,
              label_color,
              label_category,
              label_status,
              count(distinct application_id)::text as application_count
         from grant_application_github_labels
        group by label_name, label_slug, label_color, label_category, label_status, label_order
        order by label_order, label_name`
    ),
    query<UnderReviewApplicationRow>(
      `select ga.id::text,
              ga.title,
              ga.applicant_name,
              coalesce(github_issue_source.created_at, ga.created_at)::text as outstanding_since,
              case
                when github_issue_source.created_at is not null then 'github_created_at'
                else 'canonical_created_at'
              end as outstanding_basis,
              greatest(
                0,
                (current_timestamp at time zone 'America/New_York')::date
                  - (coalesce(github_issue_source.created_at, ga.created_at) at time zone 'America/New_York')::date
              ) as days_outstanding,
              latest_briefing.id as latest_briefing_id,
              latest_briefing.title as latest_briefing_title
         from grant_applications ga
         left join lateral (
           select min(
                    case
                      when pg_input_is_valid(
                        nullif(sr_created.raw_payload->>'created_at', ''),
                        'timestamp with time zone'
                      ) then nullif(sr_created.raw_payload->>'created_at', '')::timestamptz
                      else null
                    end
                  ) as created_at
             from source_links sl_created
             join source_records sr_created on sr_created.id = sl_created.source_record_id
            where sl_created.canonical_type = 'grant_application'
              and sl_created.canonical_id = ga.id
              and sr_created.source_kind = 'github_issue'
         ) github_issue_source on true
         left join lateral (
           select gar.id::text,
                  gar.title
             from grant_analysis_reports gar
            where gar.application_id = ga.id
              and gar.report_type = 'committee_briefing'
              and gar.visibility = 'shared'
              and gar.status = 'succeeded'
              and nullif(trim(gar.answer_text), '') is not null
            order by gar.created_at desc,
                     gar.version_number desc
            limit 1
         ) latest_briefing on true
        where ga.normalized_status = 'under_review'
          and exists (
            select 1
              from grant_application_github_labels official_application_label
             where official_application_label.application_id = ga.id
               and official_application_label.label_status = 'grant_application'
          )
          and exists (
            select 1
              from grant_application_github_labels official_review_label
             where official_review_label.application_id = ga.id
               and official_review_label.label_status = 'ready_for_zcg_review'
          )
        order by ${worklistOrderSql}`
    ),
    query<{ total_results: string }>(
      `select count(*)::text as total_results
         from grant_applications ga
        where ${applicationWhereClause}`,
      applicationWhereValues
    )
  ]);
  const totalResults = applicationResultCount.rows[0]?.total_results ?? "0";
  const totalPages = Math.max(1, Math.ceil(Number(totalResults) / applicationPageSize));
  const boundedPage = Math.min(page, totalPages);
  const offset = (boundedPage - 1) * applicationPageSize;
  const applicationQueryValues = [...applicationWhereValues, applicationPageSize, offset];
  const applications = await query<GrantApplicationListRow>(
    `select ga.id::text,
            ga.title,
            ga.applicant_name,
            ga.normalized_status,
            ga.requested_amount_usd::text,
            g.approved_amount_usd::text,
            ga.github_issue_number::text,
            ga.github_issue_url,
            primary_forum.source_url as primary_forum_url,
            (
              select coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'labelName', gal.label_name,
                    'labelSlug', gal.label_slug,
                    'labelColor', gal.label_color,
                    'labelDescription', gal.label_description,
                    'labelCategory', gal.label_category,
                    'labelStatus', gal.label_status,
                    'milestoneNumber', gal.milestone_number,
                    'labelOrder', gal.label_order
                  )
                  order by gal.label_order, gal.label_name
                ),
                '[]'::jsonb
              )::text
                from grant_application_github_labels gal
               where gal.application_id = ga.id
            ) as github_labels,
            coalesce(submission_event.submitted_at, github_issue_source.created_at, ga.created_at)::text as submitted_at,
            case
              when submission_event.submitted_at is not null then 'status_event'
              when github_issue_source.created_at is not null then 'github_created'
              when ga.created_at is not null then 'record_added'
              else null
            end as submitted_basis,
            case
              when submission_event.submitted_at is not null then submission_event.provenance
              when github_issue_source.created_at is not null then 'inferred'
              else 'observed'
            end as submitted_provenance,
            current_status_event.effective_at::text as status_effective_at,
            current_status_event.effective_date::text as status_effective_date,
            current_status_event.observed_at::text as status_observed_at,
            current_status_event.provenance as status_provenance,
            current_status_event.source_kind as status_source_kind,
            current_status_event.event_type as status_event_type,
            latest_briefing.id as latest_briefing_id,
            latest_briefing.title as latest_briefing_title,
            case
              when latest_briefing.id is null then null
              when not exists (
                select 1
                  from grant_analysis_report_evidence evidence_snapshot
                 where evidence_snapshot.report_id = latest_briefing.id
              ) then 'unknown'
              when exists (
                select 1
                  from grant_analysis_report_evidence evidence_snapshot
                  left join grant_knowledge_documents current_document
                    on current_document.document_key = evidence_snapshot.document_key
                 where evidence_snapshot.report_id = latest_briefing.id
                   and (
                     current_document.document_key is null
                     or current_document.content_hash is distinct from evidence_snapshot.content_hash
                   )
              ) then 'changed'
              else 'current'
            end as latest_briefing_evidence_status
       from grant_applications ga
       left join grants g on g.application_id = ga.id
       left join lateral (
         select coalesce(
                  status_event.effective_at,
                  status_event.effective_date::timestamp at time zone 'America/New_York',
                  status_event.observed_at
                ) as submitted_at,
                status_event.provenance
           from grant_application_status_events status_event
          where status_event.application_id = ga.id
            and status_event.to_status = 'submitted'
            and status_event.event_type <> 'retraction'
            and not exists (
              select 1
                from grant_application_status_events correction
               where correction.corrects_event_id = status_event.id
            )
          order by case status_event.provenance
                     when 'exact' then 10
                     when 'inferred' then 20
                     else 30
                   end,
                   coalesce(
                     status_event.effective_at,
                     status_event.effective_date::timestamp at time zone 'America/New_York',
                     status_event.observed_at
                   ) asc,
                   status_event.created_at asc,
                   status_event.id
          limit 1
       ) submission_event on true
       left join lateral (
         select min(
                  case
                    when pg_input_is_valid(
                      nullif(github_source.raw_payload->>'created_at', ''),
                      'timestamp with time zone'
                    ) then nullif(github_source.raw_payload->>'created_at', '')::timestamptz
                    else null
                  end
                ) as created_at
           from source_links github_link
           join source_records github_source on github_source.id = github_link.source_record_id
          where github_link.canonical_type = 'grant_application'
            and github_link.canonical_id = ga.id
            and github_source.source_kind = 'github_issue'
       ) github_issue_source on true
       left join lateral (
         select status_event.effective_at,
                status_event.effective_date,
                status_event.observed_at,
                status_event.provenance,
                status_event.source_kind,
                status_event.event_type
           from grant_application_status_events status_event
          where status_event.application_id = ga.id
            and status_event.to_status = ga.normalized_status
            and status_event.event_type <> 'retraction'
            and not exists (
              select 1
                from grant_application_status_events correction
               where correction.corrects_event_id = status_event.id
            )
          order by status_event.created_at desc, status_event.id desc
          limit 1
       ) current_status_event on true
       left join lateral (
         select forum_source.source_url
           from source_links forum_link
           join source_records forum_source on forum_source.id = forum_link.source_record_id
          where forum_link.canonical_type = 'grant_application'
            and forum_link.canonical_id = ga.id
            and forum_source.source_kind = 'forum_link'
            and forum_link.relationship_role = 'primary_forum_thread'
          order by forum_link.confidence desc, forum_link.created_at asc
          limit 1
       ) primary_forum on true
       left join lateral (
         select report.id,
                report.title
           from grant_analysis_reports report
          where report.application_id = ga.id
            and report.report_type = 'committee_briefing'
            and report.visibility = 'shared'
            and report.status = 'succeeded'
            and nullif(trim(report.answer_text), '') is not null
          order by report.created_at desc,
                   report.version_number desc
          limit 1
       ) latest_briefing on true
      where ${applicationWhereClause}
      order by ${applicationOrderSql[sort]}
      limit $${applicationLimitParam} offset $${applicationOffsetParam}`,
    applicationQueryValues
  );

  return {
    syncRuns: syncRuns.rows,
    sourceCounts: sourceCounts.rows,
    reconciliationSummary: reconciliationSummary.rows,
    forumRoleTotals: forumRoleTotals.rows[0] ?? { primary_forum_threads: "0", supporting_forum_references: "0" },
    applicationTotals: applicationTotals.rows[0] ?? emptyApplicationTotals,
    applicationStatusOptions: applicationStatusOptions.rows,
    githubIssueStateOptions: githubIssueStateOptions.rows,
    applicationLabelOptions: applicationLabelOptions.rows,
    underReviewApplications: underReviewApplications.rows,
    activeApplicationFilter: applicationFilter,
    applicationPagination: {
      page: boundedPage,
      pageSize: applicationPageSize,
      totalResults,
      totalPages,
      search,
      status,
      githubIssueState: issueState,
      labels,
      excludedLabels,
      sort
    } satisfies ApplicationPagination,
    applications: applications.rows
  };
}

export async function getGrantApplicationHeading(id: string) {
  const result = await query<GrantApplicationHeadingRow>(
    `select id::text,
            title,
            applicant_name
       from grant_applications
      where id = $1`,
    [id]
  );

  return result.rows[0] ?? null;
}

export async function getGrantApplicationDetail(id: string) {
  const [application, githubLabels, forumLinks, decisionMentions, sources, issues, milestones] = await Promise.all([
    query<GrantApplicationRow>(
      `select ga.id::text,
              ga.title,
              ga.applicant_name,
              ga.normalized_status,
              ga.requested_amount_usd::text,
              ga.match_confidence::text,
              ${sourceProfileSql()} as source_profile,
              ga.github_issue_number::text,
              ga.github_issue_url,
              ga.github_state,
              count(distinct sl.source_record_id)::text as source_count,
              count(distinct sl.source_record_id) filter (where sr.source_kind = 'forum_link')::text as forum_link_count,
              count(distinct sl.source_record_id) filter (
                where sr.source_kind = 'forum_link'
                  and sl.relationship_role = 'primary_forum_thread'
              )::text as primary_forum_thread_count,
              count(distinct sl.source_record_id) filter (
                where sr.source_kind = 'forum_link'
                  and coalesce(sl.relationship_role, 'source_evidence') <> 'primary_forum_thread'
              )::text as supporting_forum_reference_count,
              (
                select count(*)::text
                  from grant_decision_mentions gdm_count
                 where gdm_count.application_id = ga.id
                   and gdm_count.review_status = 'accepted'
              ) as decision_mention_count,
              (
                select count(*)::text
                  from grant_application_github_labels gal_count
                 where gal_count.application_id = ga.id
              ) as github_label_count,
              (
                select coalesce(
                  jsonb_agg(
                    jsonb_build_object(
                      'labelName', gal.label_name,
                      'labelSlug', gal.label_slug,
                      'labelColor', gal.label_color,
                      'labelDescription', gal.label_description,
                      'labelCategory', gal.label_category,
                      'labelStatus', gal.label_status,
                      'milestoneNumber', gal.milestone_number,
                      'labelOrder', gal.label_order
                    )
                    order by gal.label_order, gal.label_name
                  ),
                  '[]'::jsonb
                )::text
                  from grant_application_github_labels gal
                 where gal.application_id = ga.id
              ) as github_labels,
              count(distinct ri.id) filter (where ri.status = 'open')::text as open_issue_count,
              ga.updated_at::text
         from grant_applications ga
         left join source_links sl on sl.canonical_type = 'grant_application'
                                  and sl.canonical_id = ga.id
         left join source_records sr on sr.id = sl.source_record_id
         left join reconciliation_issues ri on ri.canonical_type = 'grant_application'
                                           and ri.canonical_id = ga.id
        where ga.id = $1
        group by ga.id`,
      [id]
    ),
    query<GitHubLabelRow>(
      `select application_id::text,
              label_name,
              label_slug,
              label_color,
              label_description,
              label_category,
              label_status,
              milestone_number::text,
              label_order::text,
              source_url,
              observed_at::text
         from grant_application_github_labels
        where application_id = $1
        order by label_order, label_name`,
      [id]
    ),
    query<ForumLinkRow>(
      `select sr.id::text,
              sr.source_id,
              sr.source_url,
              sr.title,
              sr.summary,
              sl.confidence::text,
              sl.relationship_role,
              sr.metadata::text
         from source_links sl
         join source_records sr on sr.id = sl.source_record_id
        where sl.canonical_type = 'grant_application'
          and sl.canonical_id = $1
          and sr.source_kind = 'forum_link'
        order by sr.source_url`,
      [id]
    ),
    query<DecisionMentionRow>(
      `select gdm.id::text,
              gdm.candidate_title,
              gdm.normalized_decision,
              gdm.decision_text,
              gdm.rationale_text,
              gdm.speaker_notes::text,
              gdm.match_method,
              gdm.confidence::text,
              gdm.review_status,
              gdm.linked_source_url,
              gds.meeting_date::text,
              gds.title as meeting_title,
              gds.topic_url,
              gds.source_record_id::text,
              gdm.updated_at::text
         from grant_decision_mentions gdm
         join grant_decision_sources gds on gds.id = gdm.decision_source_id
        where gdm.application_id = $1
          and gdm.review_status = 'accepted'
        order by gds.meeting_date desc nulls last, gdm.updated_at desc`,
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
              sl.relationship_role,
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
    ),
    query<GrantMilestoneLedgerRow>(
      `select gm.id::text,
              gm.application_id::text,
              gm.source_record_id::text,
              gm.milestone_label,
              gm.milestone_number::text,
              gm.milestone_type,
              gm.reporting_frequency,
              gm.category,
              gm.grantee_name,
              gm.amount_usd::text,
              gm.estimate_text,
              gm.estimated_at::text,
              gm.grant_status,
              gm.match_confidence::text,
              gm.linkage_method,
              gm.source_url,
              gm.source_row_number::text,
              gd.paid_at::text,
              gd.zec_amount::text,
              gd.usd_amount::text as disbursement_usd_amount,
              gd.exchange_rate_usd_per_zec::text,
              gd.source_url as disbursement_source_url
         from grant_milestones gm
         left join grant_disbursements gd on gd.milestone_id = gm.id
        where gm.application_id = $1
        order by case
                   when gm.milestone_type = 'startup_funding' then 0
                   when gm.milestone_type = 'numbered' then 1
                   else 2
                 end,
                 gm.milestone_number nulls last,
                 lower(gm.milestone_label),
                 gd.paid_at nulls last`,
      [id]
    )
  ]);

  return {
    application: application.rows[0] ?? null,
    githubLabels: githubLabels.rows,
    forumLinks: forumLinks.rows,
    decisionMentions: decisionMentions.rows,
    sources: sources.rows,
    issues: issues.rows,
    milestones: milestones.rows
  };
}
