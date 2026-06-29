import Link from "next/link";
import {
  getAdminDashboard,
  normalizeApplicationFilter,
  type ApplicationFilter,
  type GrantApplicationRow
} from "@/lib/admin/dashboard";
import { requirePermission } from "@/lib/authorization";

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
  searchParams?: Promise<{ applicationFilter?: string | string[] }>;
}) {
  const principal = await requirePermission("admin:dashboard:view");
  await requirePermission("source:mirror:read");
  await requirePermission("grant:read");
  await requirePermission("reconciliation:read");
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const activeApplicationFilter = normalizeApplicationFilter(resolvedSearchParams.applicationFilter);
  const dashboard = await getAdminDashboard(activeApplicationFilter);
  const totals = dashboard.applicationTotals;
  const totalSourceRecords = dashboard.sourceCounts.reduce(
    (total, row) => total + Number(row.record_count),
    0
  );
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

  return (
    <main className="admin-shell">
      <section className="admin-header">
        <div>
          <p className="eyebrow">Admin console</p>
          <h1>Source mirror and reconciliation dashboard</h1>
          <p className="lead">
            Signed in as <span className="code">{principal.email}</span>.
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
              Forum links pending
            </p>
          </div>
        </article>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Application reconciliation</h2>
            <span className="section-count">
              Showing {numberText(dashboard.applications.length)} of {numberText(activeApplicationTotal)}
            </span>
          </div>
        </div>
        <nav className="filter-tabs" aria-label="Application reconciliation filters">
          {applicationFilterOptions.map((option) => {
            const active = option.key === activeApplicationFilter;
            const href = option.key === "all" ? "/admin" : `/admin?applicationFilter=${option.key}`;

            return (
              <Link aria-current={active ? "page" : undefined} className={`filter-tab ${active ? "active" : ""}`} href={href} key={option.key}>
                <span>{option.label}</span>
                <strong>{numberText(applicationFilterCounts[option.key])}</strong>
              </Link>
            );
          })}
        </nav>
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
                <th>Issues</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.applications.length ? (
                dashboard.applications.map((application) => (
                  <tr key={application.id}>
                    <td>
                      <Link className="table-link" href={`/admin/grants/${application.id}`}>
                        {application.title}
                      </Link>
                      <span className="subtle">{application.applicant_name ?? "Unknown applicant"}</span>
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
                    <td>{numberText(application.open_issue_count)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7}>No application records match this filter.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
