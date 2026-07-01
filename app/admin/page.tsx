import type { CSSProperties } from "react";
import Link from "next/link";
import {
  getAdminDashboard,
  normalizeApplicationFilter,
  normalizeApplicationPage,
  normalizeApplicationSearch,
  normalizeApplicationStatus,
  type ApplicationFilter,
  type GrantApplicationRow
} from "@/lib/admin/dashboard";
import { isPublicPrototypePrincipal, principalHasRole, requirePermission } from "@/lib/authorization";

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
  applicationPage?: number;
}) {
  const searchParams = new URLSearchParams();

  if (params.applicationFilter && params.applicationFilter !== "all") {
    searchParams.set("applicationFilter", params.applicationFilter);
  }

  if (params.applicationSearch) {
    searchParams.set("applicationSearch", params.applicationSearch);
  }

  if (params.applicationStatus) {
    searchParams.set("applicationStatus", params.applicationStatus);
  }

  if (params.applicationPage && params.applicationPage > 1) {
    searchParams.set("applicationPage", String(params.applicationPage));
  }

  const queryString = searchParams.toString();
  return queryString ? `/admin?${queryString}` : "/admin";
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

export default async function AdminPage({
  searchParams
}: {
  searchParams?: Promise<{
    applicationFilter?: string | string[];
    applicationSearch?: string | string[];
    applicationStatus?: string | string[];
    applicationPage?: string | string[];
  }>;
}) {
  const publicReadOptions = { allowPublicPrototypeRead: true };
  const principal = await requirePermission("admin:dashboard:view", publicReadOptions);
  await requirePermission("source:mirror:read", publicReadOptions);
  await requirePermission("grant:read", publicReadOptions);
  await requirePermission("reconciliation:read", publicReadOptions);
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const activeApplicationFilter = normalizeApplicationFilter(resolvedSearchParams.applicationFilter);
  const activeApplicationSearch = normalizeApplicationSearch(resolvedSearchParams.applicationSearch);
  const activeApplicationStatus = normalizeApplicationStatus(resolvedSearchParams.applicationStatus);
  const activeApplicationPage = normalizeApplicationPage(resolvedSearchParams.applicationPage);
  const dashboard = await getAdminDashboard({
    applicationFilter: activeApplicationFilter,
    applicationSearch: activeApplicationSearch,
    applicationStatus: activeApplicationStatus,
    applicationPage: activeApplicationPage
  });
  const totals = dashboard.applicationTotals;
  const pagination = dashboard.applicationPagination;
  const totalSourceRecords = dashboard.sourceCounts.reduce(
    (total, row) => total + Number(row.record_count),
    0
  );
  const forumLinkCount = dashboard.sourceCounts.find((row) => row.source_kind === "forum_link")?.record_count ?? "0";
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
    applicationPage: pagination.page - 1
  });
  const nextPageHref = adminHref({
    applicationFilter: activeApplicationFilter,
    applicationSearch: pagination.search,
    applicationStatus: pagination.status,
    applicationPage: pagination.page + 1
  });
  const activeResultQualifiers = [
    pagination.search ? `"${pagination.search}"` : null,
    pagination.status ? `status ${statusLabel(pagination.status)}` : null
  ].filter(Boolean);
  const canManageUsers =
    !isPublicPrototypePrincipal(principal) &&
    (await principalHasRole(principal.id, "admin"));

  return (
    <main className="admin-shell">
      <section className="admin-header">
        <div>
          <p className="eyebrow">Admin console</p>
          <h1>Source mirror and reconciliation dashboard</h1>
          <p className="lead">
            {isPublicPrototypePrincipal(principal) ? (
              <>
                Public read-only prototype view. <Link className="table-link" href="/sign-in">Sign in</Link> for admin operations.
              </>
            ) : (
              <>
                Signed in as <span className="code">{principal.email}</span>.
              </>
            )}
          </p>
        </div>
      </section>

      <section className="metric-grid" aria-label="Operational summary">
        <article className="metric-card">
          <span className="metric-label">Source records</span>
          <strong>{numberText(totalSourceRecords)}</strong>
        </article>
        <article className="metric-card">
          <span className="metric-label">Canonical applications</span>
          <strong>{numberText(totals.total_applications)}</strong>
          <span className="metric-note">Total normalized application records</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Canonical grants</span>
          <strong>{numberText(totals.total_grants)}</strong>
          <span className="metric-note">Applications with grant records</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">Open reconciliation</span>
          <strong>{numberText(openReconciliationIssues)}</strong>
          <span className="metric-note">Items needing review or confirmation</span>
        </article>
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
                  <th>Seen</th>
                  <th>Updated</th>
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
            <h2>Source records</h2>
          </div>
          <div className="source-counts">
            {dashboard.sourceCounts.map((row) => (
              <div className="source-count" key={row.source_kind}>
                <span>{row.source_kind}</span>
                <strong>{numberText(row.record_count)}</strong>
                <small>{dateText(row.latest_updated_at)}</small>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="admin-grid two-column">
        <article className="panel">
          <div className="section-heading">
            <h2>Reconciliation</h2>
          </div>
          <div className="status-list">
            {dashboard.reconciliationSummary.length ? (
              dashboard.reconciliationSummary.map((row) => (
                <p className="status-item" key={`${row.status}-${row.severity}`}>
                  <span className={`dot ${row.severity === "error" ? "red" : row.severity === "warning" ? "amber" : "blue"}`} />
                  <span>{row.status}</span>
                  <span>{row.severity}</span>
                  <strong>{numberText(row.issue_count)}</strong>
                </p>
              ))
            ) : (
              <p>No reconciliation issues recorded.</p>
            )}
          </div>
        </article>

        <article className="panel">
          <div className="section-heading">
            <h2>Phase 2 slice</h2>
          </div>
          <div className="status-list">
            <p className="status-item">
              <span className="dot green" />
              Matched GitHub + Sheet records
              <strong>{numberText(totals.matched_applications)}</strong>
            </p>
            <p className="status-item">
              <span className="dot amber" />
              GitHub-only records
              <strong>{numberText(totals.github_only_applications)}</strong>
            </p>
            <p className="status-item">
              <span className="dot amber" />
              Sheet-only records
              <strong>{numberText(totals.sheet_only_applications)}</strong>
            </p>
            <p className="status-item">
              <span className="dot blue" />
              Forum links associated
              <strong>{numberText(forumLinkCount)}</strong>
            </p>
          </div>
        </article>

        {canManageUsers ? (
          <article className="panel">
            <div className="section-heading">
              <h2>Admin tools</h2>
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

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Application reconciliation</h2>
            <span className="section-count">
              {resultRangeText(
                pagination.page,
                pagination.pageSize,
                pagination.totalResults,
                dashboard.applications.length
              )}
              {activeResultQualifiers.length ? ` for ${activeResultQualifiers.join(" and ")}` : ""}
            </span>
            {pagination.search || pagination.status ? (
              <span className="section-count">
                {numberText(activeApplicationTotal)} records in this source filter before table filters
              </span>
            ) : null}
          </div>
        </div>
        <nav className="filter-tabs" aria-label="Application reconciliation filters">
          {applicationFilterOptions.map((option) => {
            const active = option.key === activeApplicationFilter;
            const href = adminHref({
              applicationFilter: option.key,
              applicationSearch: pagination.search,
              applicationStatus: pagination.status
            });

            return (
              <Link aria-current={active ? "page" : undefined} className={`filter-tab ${active ? "active" : ""}`} href={href} key={option.key}>
                <span>{option.label}</span>
                <strong>{numberText(applicationFilterCounts[option.key])}</strong>
              </Link>
            );
          })}
        </nav>
        <form action="/admin" className="table-controls" method="get">
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
            <select defaultValue={pagination.status} name="applicationStatus">
              <option value="">Any status</option>
              {dashboard.applicationStatusOptions.map((option) => (
                <option key={option.normalized_status} value={option.normalized_status}>
                  {statusLabel(option.normalized_status)} ({numberText(option.application_count)})
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Search</button>
          {pagination.search || pagination.status ? (
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
                <th>Sources</th>
                <th>Forum</th>
                <th>Issues</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.applications.length ? (
                dashboard.applications.map((application) => {
                  const githubLabels = parseGitHubLabels(application.github_labels);

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
                      </td>
                      <td>
                        <span className={`badge ${application.normalized_status}`}>{application.normalized_status}</span>
                      </td>
                      <td>{moneyText(application.requested_amount_usd)}</td>
                      <td>{matchText(application)}</td>
                      <td>{numberText(application.source_count)}</td>
                      <td>{numberText(application.forum_link_count)}</td>
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
        <nav className="pagination" aria-label="Application reconciliation pages">
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
      </section>
    </main>
  );
}
