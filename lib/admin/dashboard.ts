import { query } from "@/lib/db";

export const applicationFilters = ["all", "matched", "github_only", "sheet_only", "needs_review"] as const;
export const githubIssueStates = ["open", "closed", "none"] as const;
const applicationPageSize = 20;

export type ApplicationFilter = (typeof applicationFilters)[number];
export type GitHubIssueStateFilter = (typeof githubIssueStates)[number];

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
  source_profile: "matched" | "github_only" | "sheet_only" | "unknown";
  github_issue_number: string | null;
  github_issue_url: string | null;
  github_state: string | null;
  source_count: string;
  forum_link_count: string;
  github_label_count: string;
  github_labels: string;
  open_issue_count: string;
  updated_at: string;
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

const applicationFilterWhere: Record<ApplicationFilter, string> = {
  all: "true",
  matched: "ga.canonical_key like 'github:%' and ga.match_confidence > 0",
  github_only: "ga.canonical_key like 'github:%' and ga.match_confidence = 0",
  sheet_only: "(ga.canonical_key like 'sheet:%' or ga.canonical_key like 'sheet-all-grants:%')",
  needs_review: `exists (
    select 1
      from reconciliation_issues ri_filter
     where ri_filter.canonical_type = 'grant_application'
       and ri_filter.canonical_id = ga.id
       and ri_filter.status = 'open'
  )`
};

function sourceProfileSql(alias = "ga") {
  return `case
            when ${alias}.canonical_key like 'github:%' and ${alias}.match_confidence > 0 then 'matched'
            when ${alias}.canonical_key like 'github:%' then 'github_only'
            when ${alias}.canonical_key like 'sheet:%' or ${alias}.canonical_key like 'sheet-all-grants:%' then 'sheet_only'
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
  excludedApplicationLabels = []
}: {
  applicationFilter?: ApplicationFilter;
  applicationPage?: number;
  applicationSearch?: string;
  applicationStatus?: string;
  githubIssueState?: string;
  applicationLabels?: string[];
  excludedApplicationLabels?: string[];
} = {}) {
  const whereClause = applicationFilterWhere[applicationFilter];
  const search = normalizeApplicationSearch(applicationSearch);
  const status = normalizeApplicationStatus(applicationStatus);
  const issueState = normalizeGitHubIssueState(githubIssueState);
  const excludedLabels = normalizeApplicationLabels(excludedApplicationLabels);
  const labels = normalizeApplicationLabels(applicationLabels).filter((label) => !excludedLabels.includes(label));
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
    applicationTotals,
    applicationStatusOptions,
    githubIssueStateOptions,
    applicationLabelOptions,
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
    query<ApplicationTotalsRow>(
      `select count(*)::text as total_applications,
              (select count(*)::text from grants) as total_grants,
              count(*) filter (where ga.canonical_key like 'github:%' and ga.match_confidence > 0)::text
                as matched_applications,
              count(*) filter (where ga.canonical_key like 'github:%' and ga.match_confidence = 0)::text
                as github_only_applications,
              count(*) filter (where ga.canonical_key like 'sheet:%' or ga.canonical_key like 'sheet-all-grants:%')::text
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
  const applications = await query<GrantApplicationRow>(
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
      where ${applicationWhereClause}
      group by ga.id
      order by ga.updated_at desc
      limit $${applicationLimitParam} offset $${applicationOffsetParam}`,
    applicationQueryValues
  );

  return {
    syncRuns: syncRuns.rows,
    sourceCounts: sourceCounts.rows,
    reconciliationSummary: reconciliationSummary.rows,
    applicationTotals: applicationTotals.rows[0] ?? emptyApplicationTotals,
    applicationStatusOptions: applicationStatusOptions.rows,
    githubIssueStateOptions: githubIssueStateOptions.rows,
    applicationLabelOptions: applicationLabelOptions.rows,
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
      excludedLabels
    } satisfies ApplicationPagination,
    applications: applications.rows
  };
}

export async function getGrantApplicationDetail(id: string) {
  const [application, githubLabels, forumLinks, sources, issues] = await Promise.all([
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
              sr.metadata::text
         from source_links sl
         join source_records sr on sr.id = sl.source_record_id
        where sl.canonical_type = 'grant_application'
          and sl.canonical_id = $1
          and sr.source_kind = 'forum_link'
        order by sr.source_url`,
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
    githubLabels: githubLabels.rows,
    forumLinks: forumLinks.rows,
    sources: sources.rows,
    issues: issues.rows
  };
}
