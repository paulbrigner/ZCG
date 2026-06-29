import Link from "next/link";
import { notFound } from "next/navigation";
import { getGrantApplicationDetail, type GrantApplicationRow } from "@/lib/admin/dashboard";
import { requirePermission } from "@/lib/authorization";

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

function parseJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function compactJson(value: string) {
  const parsed = parseJson(value);
  const entries = Object.entries(parsed).slice(0, 8);

  if (!entries.length) {
    return "No structured metadata.";
  }

  return entries
    .map(([key, entry]) => `${key}: ${typeof entry === "object" ? JSON.stringify(entry) : String(entry)}`)
    .join(" | ");
}

export default async function GrantApplicationPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission("grant:read");
  await requirePermission("source:mirror:read");
  await requirePermission("reconciliation:read");

  const { id } = await params;
  const detail = await getGrantApplicationDetail(id);

  if (!detail.application) {
    notFound();
  }

  const application = detail.application;

  return (
    <main className="admin-shell">
      <section className="admin-header">
        <div>
          <p className="eyebrow">Canonical application</p>
          <h1>{application.title}</h1>
          <p className="lead">
            <Link className="table-link" href="/admin">
              Admin dashboard
            </Link>
          </p>
        </div>
      </section>

      <section className="metric-grid" aria-label="Application summary">
        <article className="metric-card">
          <span className="metric-label">Applicant</span>
          <strong>{application.applicant_name ?? "Unknown"}</strong>
        </article>
        <article className="metric-card">
          <span className="metric-label">Status</span>
          <strong>{application.normalized_status}</strong>
        </article>
        <article className="metric-card">
          <span className="metric-label">Requested</span>
          <strong>{moneyText(application.requested_amount_usd)}</strong>
        </article>
        <article className="metric-card">
          <span className="metric-label">Source state</span>
          <strong>{sourceProfileLabel(application.source_profile)}</strong>
        </article>
        <article className="metric-card">
          <span className="metric-label">GitHub-Sheet match</span>
          <strong>{matchText(application)}</strong>
        </article>
      </section>

      <section className="admin-grid two-column">
        <article className="panel">
          <div className="section-heading">
            <h2>Source evidence</h2>
          </div>
          <div className="evidence-list">
            {detail.sources.map((source) => (
              <article className="evidence-item" key={source.id}>
                <div>
                  <span className="badge neutral">{source.source_kind}</span>
                  <h3>{source.title ?? source.source_id}</h3>
                  <p>{source.summary ?? "No source summary available."}</p>
                </div>
                <dl className="evidence-meta">
                  <div>
                    <dt>Confidence</dt>
                    <dd>{percentText(source.confidence)}</dd>
                  </div>
                  <div>
                    <dt>Source ID</dt>
                    <dd>{source.source_id}</dd>
                  </div>
                </dl>
                {source.source_url ? (
                  <a className="table-link" href={source.source_url}>
                    Open source record
                  </a>
                ) : null}
                <p className="subtle">{compactJson(source.metadata)}</p>
              </article>
            ))}
          </div>
        </article>

        <article className="panel">
          <div className="section-heading">
            <h2>Reconciliation issues</h2>
          </div>
          <div className="evidence-list">
            {detail.issues.length ? (
              detail.issues.map((issue) => (
                <article className="evidence-item" key={issue.id}>
                  <div className="issue-heading">
                    <span className={`badge ${issue.severity}`}>{issue.severity}</span>
                    <span className={`badge ${issue.status}`}>{issue.status}</span>
                  </div>
                  <h3>{issue.summary}</h3>
                  <p>{issue.issue_type}</p>
                  <p className="subtle">{compactJson(issue.details)}</p>
                </article>
              ))
            ) : (
              <p>No reconciliation issues recorded.</p>
            )}
          </div>
        </article>
      </section>
    </main>
  );
}
