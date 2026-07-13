import type { CSSProperties } from "react";
import Link from "next/link";
import {
  getAdminDashboard,
  normalizeApplicationFilter,
  normalizeApplicationLabels,
  normalizeApplicationPage,
  normalizeApplicationSearch,
  normalizeApplicationStatus,
  normalizeGitHubIssueState,
  type ApplicationFilter,
  type GrantApplicationRow
} from "@/lib/admin/dashboard";
import { isPublicPrototypePrincipal, principalHasRole, requirePermission } from "@/lib/authorization";
import { MetricHelp, MetricLabel } from "./metric-help";

type GitHubLabelSummary = {
  labelName: string;
  labelSlug: string;
  labelColor: string | null;
  labelDescription: string | null;
  labelCategory: string;
  labelStatus: string | null;
  milestoneNumber: number | null;
  labelOrder: number;
};

function numberText(value: string | number | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US") : "0";
}

function moneyText(value: string | null) {
  if (!value) {
    return "-";
  }

  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    : "-";
}

function percentText(value: string | null) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? `${Math.round(parsed * 100)}%` : "0%";
}

function sourceProfileLabel(profile: GrantApplicationRow["source_profile"]) {
  switch (profile) {
    case "matched":
      return "GitHub + Sheet";
    case "github_only":
      return "GitHub only";
    case "sheet_github_linked":
      return "Sheet + GitHub link";
    case "sheet_only":
      return "Sheet only";
    default:
      return "Unknown";
  }
}

function matchText(application: GrantApplicationRow) {
  if (application.source_profile === "github_only") {
    return "No Sheet match";
  }

  if (application.source_profile === "sheet_only") {
    return "No GitHub match";
  }

  if (application.source_profile === "sheet_github_linked") {
    return application.github_issue_number ? `GitHub #${application.github_issue_number} linked` : "GitHub linked";
  }

  if (application.source_profile === "matched") {
    return percentText(application.match_confidence);
  }

  return "Unclassified";
}

function dateText(value: string | null) {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "-"
    : parsed.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
}

function statusLabel(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function githubIssueStateLabel(value: string) {
  return value === "none" ? "No GitHub issue" : statusLabel(value);
}

function githubIssueStateText(application: GrantApplicationRow) {
  if (!application.github_issue_number) {
    return "No GitHub issue";
  }

  return application.github_state
    ? `GitHub #${application.github_issue_number} ${statusLabel(application.github_state)}`
    : `GitHub #${application.github_issue_number}`;
}

function forumLinkText(application: GrantApplicationRow) {
  const primary = numberText(application.primary_forum_thread_count);
  const supporting = numberText(application.supporting_forum_reference_count);

  return { primary, supporting };
}

function parseGitHubLabels(value: string | null | undefined): GitHubLabelSummary[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as GitHubLabelSummary[]) : [];
  } catch {
    return [];
  }
}

function githubLabelStyle(label: { labelColor?: string | null }): CSSProperties | undefined {
  if (!label.labelColor || !/^[0-9a-f]{6}$/i.test(label.labelColor)) {
    return undefined;
  }

  return {
    backgroundColor: `#${label.labelColor}2b`,
    borderColor: `#${label.labelColor}`
  };
}

function GitHubLabelChips({ labels, limit }: { labels: GitHubLabelSummary[]; limit?: number }) {
  const visibleLabels = typeof limit === "number" ? labels.slice(0, limit) : labels;
  const hiddenCount = typeof limit === "number" ? Math.max(0, labels.length - limit) : 0;

  if (!labels.length) {
    return null;
  }

  return (
    <div className="github-label-list">
      {visibleLabels.map((label) => (
        <span
          className={`github-label-chip ${label.labelCategory}`}
          key={label.labelName}
          style={githubLabelStyle(label)}
          title={label.labelDescription ?? label.labelStatus ?? label.labelCategory}
        >
          {label.labelName}
        </span>
      ))}
      {hiddenCount ? <span className="github-label-chip overflow">+{numberText(hiddenCount)}</span> : null}
    </div>
  );
}

function adminHref(params: {
  applicationFilter?: ApplicationFilter;
  applicationSearch?: string;
  applicationStatus?: string;
  githubIssueState?: string;
  applicationLabels?: string[];
  excludedApplicationLabels?: string[];
  applicationPage?: number;
}) {
  const searchParams = new URLSearchParams();

  if (params.applicationFilter && params.applicationFilter !== "all") {
    searchParams.set("applicationFilter", params.applicationFilter);
  }

  if (params.applicationSearch) {
    searchParams.set("applicationSearch", params.applicationSearch);
  }

  if (params.applicationStatus === "") {
    searchParams.set("applicationStatus", "all");
  } else if (params.applicationStatus) {
    searchParams.set("applicationStatus", params.applicationStatus);
  }

  if (params.githubIssueState) {
    searchParams.set("githubIssueState", params.githubIssueState);
  }

  for (const label of params.applicationLabels ?? []) {
    searchParams.append("applicationLabels", label);
  }

  for (const label of params.excludedApplicationLabels ?? []) {
    searchParams.append("excludedApplicationLabels", label);
  }

  if (params.applicationPage && params.applicationPage > 1) {
    searchParams.set("applicationPage", String(params.applicationPage));
  }

  const queryString = searchParams.toString();
  return queryString ? `/dashboard?${queryString}` : "/dashboard";
}

function defaultedApplicationStatus(value: string | string[] | undefined) {
  if (value === undefined) {
    return "under_review";
  }

  const normalized = normalizeApplicationStatus(value);
  return normalized === "all" ? "" : normalized;
}

function resultRangeText(page: number, pageSize: number, totalResults: string, displayedCount: number) {
  const total = Number(totalResults);

  if (!displayedCount || !Number.isFinite(total) || total <= 0) {
    return "Showing 0 of 0";
  }

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(first + displayedCount - 1, total);
  return `Showing ${numberText(first)}-${numberText(last)} of ${numberText(total)}`;
}

const applicationFilterOptions: Array<{ key: ApplicationFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "matched", label: "GitHub + Sheet" },
  { key: "github_only", label: "GitHub only" },
  { key: "sheet_only", label: "Sheet only" },
  { key: "needs_review", label: "Needs review" }
];

const metricHelp = {
  sourceRecords:
    "Sum of rows in source_records across mirrored or derived evidence: Google Sheet tabs and rows, GitHub issues and comments, and Forum links discovered during reconciliation. This is evidence volume, not a unique grant count.",
  canonicalApplications:
    "Count of grant_applications rows after reconciliation normalizes GitHub issues, Sheet registry rows, payment rows, and discovered links into one application view.",
  canonicalGrants:
    "Count of grants rows derived from canonical applications that have grant-level funding/status data. It is lower than applications because not every considered application became a grant record.",
  openReconciliation:
    "Open reconciliation_issues rows generated by reconciliation. These call out missing, ambiguous, or review-worthy source relationships.",
  syncSeen:
    "records_seen from sync_runs: source records observed by the sync worker during that run before create/update/skip decisions.",
  syncUpdated:
    "records_created plus records_updated from sync_runs. This shows changed source_records rows, not total records observed.",
  sourceKind:
    "Rows in source_records for this source kind. Latest updated shows the newest source_updated_at timestamp seen for that kind.",
  reconciliationGroup:
    "Rows in reconciliation_issues grouped by status and severity. Open warning/error rows are the ones most likely to need review.",
  matched:
    "Canonical applications that currently have GitHub evidence matched to Sheet evidence or a Sheet registry row linked to a GitHub issue.",
  githubOnly:
    "Canonical applications with GitHub evidence but no matched Sheet registry/payment evidence yet.",
  sheetOnly:
    "Canonical applications from Sheet registry/payment evidence without a linked GitHub issue.",
  primaryForumThreads:
    "Forum link relationships classified as the primary grant discussion thread, usually from an explicit Forum reference comment or All Grants Forum Link field.",
  supportingForumReferences:
    "Forum link relationships classified as supporting context, such as prior funding, previous work, reports, dependencies, or background references.",
  applicationRange:
    "Visible rows in the Applications table after source filters, search, status, label, GitHub issue state, and pagination are applied.",
  preTableFilter:
    "Count for the active source-profile tab before the table search/status/label filters narrow the displayed page.",
  filterCounts:
    "Counts on filter tabs and selectors come from grant_applications and related label/state tables before pagination.",
  tableSources:
    "Distinct source_records linked to this application through source_links.",
  tableForum:
    "Primary forum thread count followed by supporting forum reference count for this application.",
  tableIssues:
    "Open reconciliation_issues linked to this application."
};

export default async function AdminPage({
  searchParams
}: {
  searchParams?: Promise<{
    applicationFilter?: string | string[];
    applicationSearch?: string | string[];
    applicationStatus?: string | string[];
    githubIssueState?: string | string[];
    applicationLabels?: string | string[];
    excludedApplicationLabels?: string | string[];
    applicationPage?: string | string[];
    dashboardView?: string | string[];
  }>;
}) {
  const publicReadOptions = { allowPublicPrototypeRead: true };
  const principal = await requirePermission("admin:dashboard:view", publicReadOptions);
  await requirePermission("source:mirror:read", publicReadOptions);
  await requirePermission("grant:read", publicReadOptions);
  await requirePermission("reconciliation:read", publicReadOptions);
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const dashboardView = Array.isArray(resolvedSearchParams.dashboardView)
    ? resolvedSearchParams.dashboardView[0]
    : resolvedSearchParams.dashboardView;

  if (dashboardView !== "1") {
    const adminPrincipal = await requirePermission("role:assignment:manage");

    return (
      <main className="admin-shell">
        <section className="admin-header">
          <div>
            <p className="eyebrow">Administration</p>
            <h1>System administration</h1>
            <p className="lead">
              Signed in as <span className="code">{adminPrincipal.email}</span>.
            </p>
          </div>
        </section>

        <section className="grid" aria-label="Administration functions">
          <article className="card">
            <h2>User access</h2>
            <p>Manage exact-email and domain role grants for authenticated users.</p>
            <Link className="table-link" href="/admin/users">Open user access</Link>
          </article>
          <article className="card">
            <h2>Reconciliation</h2>
            <p>Review generated issues and manage durable source and relationship decisions.</p>
            <Link className="table-link" href="/admin/reconciliations">Open reconciliation</Link>
          </article>
          <article className="card">
            <h2>Knowledge operations</h2>
            <p>Search indexed grant evidence and maintain indexing and embedding coverage.</p>
            <Link className="table-link" href="/admin/knowledge">Open grant knowledge</Link>
          </article>
          <article className="card">
            <h2>Grants dashboard</h2>
            <p>Return to application search, source telemetry, and grant evidence.</p>
            <Link className="table-link" href="/dashboard">Open dashboard</Link>
          </article>
        </section>
      </main>
    );
  }

  const activeApplicationFilter = normalizeApplicationFilter(resolvedSearchParams.applicationFilter);
  const activeApplicationSearch = normalizeApplicationSearch(resolvedSearchParams.applicationSearch);
  const activeApplicationStatus = defaultedApplicationStatus(resolvedSearchParams.applicationStatus);
  const activeGitHubIssueState = normalizeGitHubIssueState(resolvedSearchParams.githubIssueState);
  const activeApplicationLabels = normalizeApplicationLabels(resolvedSearchParams.applicationLabels);
  const activeExcludedApplicationLabels = normalizeApplicationLabels(resolvedSearchParams.excludedApplicationLabels);
  const activeApplicationPage = normalizeApplicationPage(resolvedSearchParams.applicationPage);
  const dashboard = await getAdminDashboard({
    applicationFilter: activeApplicationFilter,
    applicationSearch: activeApplicationSearch,
    applicationStatus: activeApplicationStatus,
    githubIssueState: activeGitHubIssueState,
    applicationLabels: activeApplicationLabels,
    excludedApplicationLabels: activeExcludedApplicationLabels,
    applicationPage: activeApplicationPage
  });
  const totals = dashboard.applicationTotals;
  const pagination = dashboard.applicationPagination;
  const totalSourceRecords = dashboard.sourceCounts.reduce(
    (total, row) => total + Number(row.record_count),
    0
  );
  const forumRoleTotals = dashboard.forumRoleTotals;
  const openReconciliationIssues = dashboard.reconciliationSummary
    .filter((row) => row.status === "open")
    .reduce((total, row) => total + Number(row.issue_count), 0);
  const applicationFilterCounts: Record<ApplicationFilter, string> = {
    all: totals.total_applications,
    matched: totals.matched_applications,
    github_only: totals.github_only_applications,
    sheet_only: totals.sheet_only_applications,
    needs_review: totals.needs_review_applications
  };
  const activeApplicationTotal = applicationFilterCounts[activeApplicationFilter];
  const previousPageHref = adminHref({
    applicationFilter: activeApplicationFilter,
    applicationSearch: pagination.search,
    applicationStatus: pagination.status,
    githubIssueState: pagination.githubIssueState,
    applicationLabels: pagination.labels,
    excludedApplicationLabels: pagination.excludedLabels,
    applicationPage: pagination.page - 1
  });
  const nextPageHref = adminHref({
    applicationFilter: activeApplicationFilter,
    applicationSearch: pagination.search,
    applicationStatus: pagination.status,
    githubIssueState: pagination.githubIssueState,
    applicationLabels: pagination.labels,
    excludedApplicationLabels: pagination.excludedLabels,
    applicationPage: pagination.page + 1
  });
  const labelTextBySlug = new Map(dashboard.applicationLabelOptions.map((option) => [option.label_slug, option.label_name]));
  const activeLabelNames = pagination.labels.map((label) => labelTextBySlug.get(label) ?? statusLabel(label));
  const excludedLabelNames = pagination.excludedLabels.map((label) => labelTextBySlug.get(label) ?? statusLabel(label));
  const activeResultQualifiers = [
    pagination.search ? `"${pagination.search}"` : null,
    pagination.status ? `status ${statusLabel(pagination.status)}` : null,
    pagination.githubIssueState
      ? pagination.githubIssueState === "none"
        ? "no GitHub issue"
        : `GitHub issue ${githubIssueStateLabel(pagination.githubIssueState)}`
      : null,
    activeLabelNames.length ? `labels ${activeLabelNames.join(" or ")}` : null,
    excludedLabelNames.length ? `without ${excludedLabelNames.join(" or ")}` : null
  ].filter(Boolean);
  const publicViewer = isPublicPrototypePrincipal(principal);
  const canManageUsers = !publicViewer && (await principalHasRole(principal.id, "admin"));
  const applicationPanelOpen = [
    resolvedSearchParams.applicationFilter,
    resolvedSearchParams.applicationSearch,
    resolvedSearchParams.applicationStatus,
    resolvedSearchParams.githubIssueState,
    resolvedSearchParams.applicationLabels,
    resolvedSearchParams.excludedApplicationLabels,
    resolvedSearchParams.applicationPage
  ].some((value) => value !== undefined);

  return (
    <main className="admin-shell">
      <section className="admin-header">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1>ZCG Grants Dashboard</h1>
          <p className="lead">
            {publicViewer ? (
              <>
                Public read-only prototype view. <Link className="table-link" href="/sign-in">Sign in</Link> for dashboard operations.
              </>
            ) : (
              <>
                Signed in as <span className="code">{principal.email}</span>.
              </>
            )}
          </p>
        </div>
      </section>

      <details className="operations-disclosure dashboard-operations" hidden>
        <summary>
          <span>Operational telemetry</span>
          <small>{publicViewer ? "Sync, source, and system counts" : "Sync, source, reconciliation, and system counts"}</small>
        </summary>
        <div className="operations-disclosure-body">
          <section className="metric-grid" aria-label="Operational summary">
            <article className="metric-card">
              <MetricLabel body={metricHelp.sourceRecords} label="Source records" text="Source records" />
              <strong>{numberText(totalSourceRecords)}</strong>
            </article>
            <article className="metric-card">
              <MetricLabel body={metricHelp.canonicalApplications} label="Canonical applications" text="Canonical applications" />
              <strong>{numberText(totals.total_applications)}</strong>
              <span className="metric-note">Total normalized application records</span>
            </article>
            <article className="metric-card">
              <MetricLabel body={metricHelp.canonicalGrants} label="Canonical grants" text="Canonical grants" />
              <strong>{numberText(totals.total_grants)}</strong>
              <span className="metric-note">Applications with grant records</span>
            </article>
            {!publicViewer ? (
              <article className="metric-card">
                <MetricLabel body={metricHelp.openReconciliation} label="Open reconciliation" text="Open reconciliation" />
                <strong>{numberText(openReconciliationIssues)}</strong>
                <span className="metric-note">Items needing review or confirmation</span>
              </article>
            ) : null}
          </section>

          <section className="admin-grid two-column">
            <article className="panel">
              <div className="section-heading">
                <h2>Sync runs</h2>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Status</th>
                      <th>
                        <span className="table-heading-with-help">
                          Seen
                          <MetricHelp body={metricHelp.syncSeen} label="Sync records seen" />
                        </span>
                      </th>
                      <th>
                        <span className="table-heading-with-help">
                          Updated
                          <MetricHelp body={metricHelp.syncUpdated} label="Sync records updated" />
                        </span>
                      </th>
                      <th>Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.syncRuns.map((run) => (
                      <tr key={run.id}>
                        <td>{run.source}</td>
                        <td>
                          <span className={`badge ${run.status}`}>{run.status}</span>
                        </td>
                        <td>{numberText(run.records_seen)}</td>
                        <td>{numberText(Number(run.records_created) + Number(run.records_updated))}</td>
                        <td>{dateText(run.completed_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>

            <article className="panel">
              <div className="section-heading">
                <h2>
                  Source records
                  <MetricHelp body={metricHelp.sourceKind} label="Source record counts" />
                </h2>
              </div>
              <div className="source-counts">
                {dashboard.sourceCounts.map((row) => (
                  <div className="source-count" key={row.source_kind}>
                    <span>
                      {row.source_kind}
                      <MetricHelp align="left" body={metricHelp.sourceKind} label={`${row.source_kind} records`} />
                    </span>
                    <strong>{numberText(row.record_count)}</strong>
                    <small>{dateText(row.latest_updated_at)}</small>
                  </div>
                ))}
              </div>
            </article>
          </section>

          <section className="admin-grid two-column">
            {!publicViewer ? (
              <article className="panel">
                <div className="section-heading">
                  <h2>
                    Reconciliation
                    <MetricHelp body={metricHelp.reconciliationGroup} label="Reconciliation counts" />
                  </h2>
                </div>
                <div className="status-list">
                  {dashboard.reconciliationSummary.length ? (
                    dashboard.reconciliationSummary.map((row) => (
                      <p className="status-item" key={`${row.status}-${row.severity}`}>
                        <span className={`dot ${row.severity === "error" ? "red" : row.severity === "warning" ? "amber" : "blue"}`} />
                        <span>{row.status}</span>
                        <span>{row.severity}</span>
                        <strong className="count-with-help">
                          {numberText(row.issue_count)}
                          <MetricHelp align="left" body={metricHelp.reconciliationGroup} label={`${row.status} ${row.severity} reconciliation issues`} />
                        </strong>
                      </p>
                    ))
                  ) : (
                    <p>No reconciliation issues recorded.</p>
                  )}
                </div>
              </article>
            ) : null}

            <article className="panel">
              <div className="section-heading">
                <h2>Phase 2 slice</h2>
              </div>
              <div className="status-list">
                <p className="status-item">
                  <span className="dot green" />
                  Matched GitHub + Sheet records
                  <strong className="count-with-help">
                    {numberText(totals.matched_applications)}
                    <MetricHelp align="left" body={metricHelp.matched} label="Matched GitHub + Sheet records" />
                  </strong>
                </p>
                <p className="status-item">
                  <span className="dot amber" />
                  GitHub-only records
                  <strong className="count-with-help">
                    {numberText(totals.github_only_applications)}
                    <MetricHelp align="left" body={metricHelp.githubOnly} label="GitHub-only records" />
                  </strong>
                </p>
                <p className="status-item">
                  <span className="dot amber" />
                  Sheet-only records
                  <strong className="count-with-help">
                    {numberText(totals.sheet_only_applications)}
                    <MetricHelp align="left" body={metricHelp.sheetOnly} label="Sheet-only records" />
                  </strong>
                </p>
                <p className="status-item">
                  <span className="dot blue" />
                  Primary forum threads
                  <strong className="count-with-help">
                    {numberText(forumRoleTotals.primary_forum_threads)}
                    <MetricHelp align="left" body={metricHelp.primaryForumThreads} label="Primary forum threads" />
                  </strong>
                </p>
                <p className="status-item">
                  <span className="dot blue" />
                  Supporting forum references
                  <strong className="count-with-help">
                    {numberText(forumRoleTotals.supporting_forum_references)}
                    <MetricHelp align="left" body={metricHelp.supportingForumReferences} label="Supporting forum references" />
                  </strong>
                </p>
                {!publicViewer ? (
                  <p className="status-item">
                    <span className="dot blue" />
                    Manual reconciliation workspace
                    <Link className="table-link" href="/admin/reconciliations">
                      Open
                    </Link>
                  </p>
                ) : null}
              </div>
            </article>

            {canManageUsers ? (
              <article className="panel">
                <div className="section-heading">
                  <h2>Dashboard tools</h2>
                </div>
                <div className="status-list">
                  <p className="status-item">
                    <span className="dot blue" />
                    User access management
                    <Link className="table-link" href="/admin/users">
                      Open
                    </Link>
                  </p>
                </div>
              </article>
            ) : null}
          </section>
        </div>
      </details>

      <section aria-labelledby="under-review-heading" className="panel under-review-worklist">
        <div className="under-review-heading">
          <div>
            <p className="eyebrow">Committee worklist</p>
            <h2 id="under-review-heading">Applications under review</h2>
          </div>
          <span className="under-review-count">{numberText(dashboard.underReviewApplications.length)}</span>
        </div>
        {dashboard.underReviewApplications.length ? (
          <div className="under-review-list">
            {dashboard.underReviewApplications.map((application) => (
              <article className="under-review-item" key={application.id}>
                <div className="under-review-identity">
                  <Link className="under-review-title" href={`/admin/grants/${application.id}`}>
                    {application.title}
                  </Link>
                  <span>{application.applicant_name ?? "Applicant not recorded"}</span>
                </div>
                <div className="under-review-actions">
                  <Link className="under-review-link" href={`/admin/grants/${application.id}`}>
                    View grant
                  </Link>
                  {application.latest_briefing_id ? (
                    <Link
                      className="under-review-link primary"
                      href={`/admin/grants/${application.id}#committee-briefing-${application.latest_briefing_id}`}
                    >
                      Open latest briefing
                    </Link>
                  ) : (
                    <span className="under-review-unavailable">No briefing yet</span>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="under-review-empty">No applications are currently under review.</p>
        )}
      </section>

      <details className="panel application-workflow application-disclosure" open={applicationPanelOpen}>
        <summary className="application-disclosure-summary">
          <span>
            <strong>Applications</strong>
            <small>Browse, search, and filter the full application registry</small>
          </span>
          <span className="application-disclosure-count">{numberText(totals.total_applications)}</span>
        </summary>
        <div className="application-disclosure-body">
          <div className="section-heading application-results-heading">
            <div>
            <span className="section-count">
              {resultRangeText(
                pagination.page,
                pagination.pageSize,
                pagination.totalResults,
                dashboard.applications.length
              )}
              {activeResultQualifiers.length ? ` for ${activeResultQualifiers.join(" and ")}` : ""}
              <MetricHelp align="left" body={metricHelp.applicationRange} label="Application range" />
            </span>
            {pagination.search || pagination.status || pagination.labels.length || pagination.excludedLabels.length ? (
              <span className="section-count">
                {numberText(activeApplicationTotal)} records in this source filter before table filters
                <MetricHelp align="left" body={metricHelp.preTableFilter} label="Source filter count" />
              </span>
            ) : null}
            </div>
            <MetricHelp body={metricHelp.filterCounts} label="Application filter counts" />
          </div>
        <nav className="filter-tabs" aria-label="Application filters">
          {applicationFilterOptions.map((option) => {
            const active = option.key === activeApplicationFilter;
            const href = adminHref({
              applicationFilter: option.key,
              applicationSearch: pagination.search,
              applicationStatus: pagination.status,
              githubIssueState: pagination.githubIssueState,
              applicationLabels: pagination.labels,
              excludedApplicationLabels: pagination.excludedLabels
            });

            return (
              <Link aria-current={active ? "page" : undefined} className={`filter-tab ${active ? "active" : ""}`} href={href} key={option.key}>
                <span>{option.label}</span>
                <strong>{numberText(applicationFilterCounts[option.key])}</strong>
              </Link>
            );
          })}
        </nav>
        <form action="/dashboard" className="table-controls" method="get">
          {activeApplicationFilter !== "all" ? (
            <input name="applicationFilter" type="hidden" value={activeApplicationFilter} />
          ) : null}
          <label className="search-field">
            <span>Search</span>
            <input
              autoComplete="off"
              defaultValue={pagination.search}
              name="applicationSearch"
              placeholder="Application, applicant, issue, source"
              type="search"
            />
          </label>
          <label className="search-field compact-field">
            <span>Status</span>
            <select defaultValue={pagination.status || "all"} name="applicationStatus">
              <option value="all">Any status</option>
              {dashboard.applicationStatusOptions.map((option) => (
                <option key={option.normalized_status} value={option.normalized_status}>
                  {statusLabel(option.normalized_status)} ({numberText(option.application_count)})
                </option>
              ))}
            </select>
          </label>
          <label className="search-field compact-field">
            <span>GitHub issue</span>
            <select defaultValue={pagination.githubIssueState} name="githubIssueState">
              <option value="">Any</option>
              {dashboard.githubIssueStateOptions.map((option) => (
                <option key={option.github_issue_state} value={option.github_issue_state}>
                  {githubIssueStateLabel(option.github_issue_state)} ({numberText(option.application_count)})
                </option>
              ))}
            </select>
          </label>
          <div className="search-field label-filter-field">
            <span>Labels</span>
            <div className="label-filter-list">
              {dashboard.applicationLabelOptions.map((option) => (
                <div className="label-filter-row" key={option.label_slug}>
                  <span className="label-filter-name">
                    <span
                      className={`github-label-chip ${option.label_category}`}
                      style={githubLabelStyle({ labelColor: option.label_color })}
                      title={option.label_status ?? option.label_category}
                    >
                      {option.label_name}
                    </span>
                    <small>{numberText(option.application_count)}</small>
                  </span>
                  <label className="label-filter-toggle include" title={`Require ${option.label_name}`}>
                    <input
                      aria-label={`Require ${option.label_name}`}
                      defaultChecked={pagination.labels.includes(option.label_slug)}
                      name="applicationLabels"
                      type="checkbox"
                      value={option.label_slug}
                    />
                    <span>+</span>
                  </label>
                  <label className="label-filter-toggle exclude" title={`Exclude ${option.label_name}`}>
                    <input
                      aria-label={`Exclude ${option.label_name}`}
                      defaultChecked={pagination.excludedLabels.includes(option.label_slug)}
                      name="excludedApplicationLabels"
                      type="checkbox"
                      value={option.label_slug}
                    />
                    <span>-</span>
                  </label>
                </div>
              ))}
            </div>
          </div>
          <button type="submit">Search</button>
          {pagination.search || pagination.status || pagination.githubIssueState || pagination.labels.length || pagination.excludedLabels.length ? (
            <Link className="ghost-link" href={adminHref({ applicationFilter: activeApplicationFilter })}>
              Clear
            </Link>
          ) : null}
        </form>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Application</th>
                <th>Source state</th>
                <th>Status</th>
                <th>Amount</th>
                <th>GitHub-Sheet match</th>
                <th>
                  <span className="table-heading-with-help">
                    Sources
                    <MetricHelp body={metricHelp.tableSources} label="Application source count" />
                  </span>
                </th>
                <th>
                  <span className="table-heading-with-help">
                    Forum
                    <MetricHelp body={metricHelp.tableForum} label="Application forum count" />
                  </span>
                </th>
                <th>
                  <span className="table-heading-with-help">
                    Issues
                    <MetricHelp body={metricHelp.tableIssues} label="Application issue count" />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {dashboard.applications.length ? (
                dashboard.applications.map((application) => {
                  const githubLabels = parseGitHubLabels(application.github_labels);
                  const forumLinks = forumLinkText(application);

                  return (
                    <tr key={application.id}>
                      <td>
                        <Link className="table-link" href={`/admin/grants/${application.id}`}>
                          {application.title}
                        </Link>
                        <span className="subtle">{application.applicant_name ?? "Unknown applicant"}</span>
                        <GitHubLabelChips labels={githubLabels} limit={5} />
                      </td>
                      <td>
                        <span className={`badge ${application.source_profile}`}>{sourceProfileLabel(application.source_profile)}</span>
                        <span className="subtle">{githubIssueStateText(application)}</span>
                      </td>
                      <td>
                        <span className={`badge ${application.normalized_status}`}>{application.normalized_status}</span>
                      </td>
                      <td>{moneyText(application.requested_amount_usd)}</td>
                      <td>{matchText(application)}</td>
                      <td>{numberText(application.source_count)}</td>
                      <td>
                        <span>{forumLinks.primary} primary</span>
                        <span className="subtle">{forumLinks.supporting} supporting</span>
                      </td>
                      <td>{numberText(application.open_issue_count)}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={8}>No application records match this filter.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <nav className="pagination" aria-label="Application pages">
          {pagination.page > 1 ? (
            <Link className="page-link" href={previousPageHref}>
              Previous
            </Link>
          ) : (
            <span className="page-link disabled">Previous</span>
          )}
          <span className="page-status">
            Page {numberText(pagination.page)} of {numberText(pagination.totalPages)}
          </span>
          {pagination.page < pagination.totalPages ? (
            <Link className="page-link" href={nextPageHref}>
              Next
            </Link>
          ) : (
            <span className="page-link disabled">Next</span>
          )}
        </nav>
        </div>
      </details>
    </main>
  );
}
