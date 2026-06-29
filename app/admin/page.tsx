import Link from "next/link";
import { getAdminDashboard } from "@/lib/admin/dashboard";
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

export default async function AdminPage() {
  const principal = await requirePermission("admin:dashboard:view");
  await requirePermission("source:mirror:read");
  await requirePermission("grant:read");
  await requirePermission("reconciliation:read");
  const dashboard = await getAdminDashboard();
  const totalSourceRecords = dashboard.sourceCounts.reduce(
    (total, row) => total + Number(row.record_count),
    0
  );
  const openReconciliationIssues = dashboard.reconciliationSummary
    .filter((row) => row.status === "open")
    .reduce((total, row) => total + Number(row.issue_count), 0);
  const completedRuns = dashboard.syncRuns.filter((run) => run.status === "completed").length;

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
          <strong>{numberText(dashboard.applications.length)}</strong>
        </article>
        <article className="metric-card">
          <span className="metric-label">Open reconciliation</span>
          <strong>{numberText(openReconciliationIssues)}</strong>
        </article>
        <article className="metric-card">
          <span className="metric-label">Recent completed syncs</span>
          <strong>{numberText(completedRuns)}</strong>
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
              GitHub applications
            </p>
            <p className="status-item">
              <span className="dot green" />
              Sheet project groups
            </p>
            <p className="status-item">
              <span className="dot amber" />
              Title-confidence matching
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
          <h2>Canonical applications</h2>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Application</th>
                <th>Status</th>
                <th>Amount</th>
                <th>Match</th>
                <th>Sources</th>
                <th>Issues</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.applications.map((application) => (
                <tr key={application.id}>
                  <td>
                    <Link className="table-link" href={`/admin/grants/${application.id}`}>
                      {application.title}
                    </Link>
                    <span className="subtle">{application.applicant_name ?? "Unknown applicant"}</span>
                  </td>
                  <td>
                    <span className={`badge ${application.normalized_status}`}>{application.normalized_status}</span>
                  </td>
                  <td>{moneyText(application.requested_amount_usd)}</td>
                  <td>{percentText(application.match_confidence)}</td>
                  <td>{numberText(application.source_count)}</td>
                  <td>{numberText(application.open_issue_count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
