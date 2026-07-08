import type { CSSProperties } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getGrantApplicationDetail, type GitHubLabelRow, type GrantApplicationRow } from "@/lib/admin/dashboard";
import { requirePermission } from "@/lib/authorization";
import { MetricHelp, MetricLabel } from "../../metric-help";

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

function statusLabel(value: string | null) {
  if (!value) {
    return "-";
  }

  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function numberText(value: string | number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US") : "0";
}

function githubLabelStyle(label: GitHubLabelRow): CSSProperties | undefined {
  if (!label.label_color || !/^[0-9a-f]{6}$/i.test(label.label_color)) {
    return undefined;
  }

  return {
    backgroundColor: `#${label.label_color}2b`,
    borderColor: `#${label.label_color}`
  };
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

const detailHelp = {
  applicant:
    "Applicant name stored on the canonical grant_applications row after reconciliation chooses the best available value from source evidence.",
  status:
    "Normalized status stored on the canonical application after interpreting GitHub labels, Sheet status fields, and reconciliation logic.",
  requested:
    "Requested amount on the canonical application, usually sourced from Sheet registry/payment fields or structured application evidence when available.",
  sourceState:
    "How the canonical application is currently supported by source evidence: matched GitHub + Sheet, GitHub only, Sheet + GitHub link, Sheet only, or unknown.",
  match:
    "Reconciliation confidence for the GitHub-to-Sheet match. GitHub-only and Sheet-only records show the missing side; sheet records with a GitHub issue link show the linked issue.",
  forumLinks:
    "Count of linked forum_link source_records associated with this canonical application through source_links.",
  githubLabels:
    "Count of GitHub issue labels captured as first-class grant_application_github_labels rows for this application.",
  githubLabelSection:
    "Structured labels copied from the GitHub issue during source mirroring and reconciliation. These are used for workflow/status filtering.",
  forumLinkSection:
    "Forum threads discovered from GitHub comments, source payloads, or Sheet fields and linked to this application during reconciliation."
};

export default async function GrantApplicationPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const publicReadOptions = { allowPublicPrototypeRead: true };
  await requirePermission("grant:read", publicReadOptions);
  await requirePermission("source:mirror:read", publicReadOptions);
  await requirePermission("reconciliation:read", publicReadOptions);

  const { id } = await params;
  const detail = await getGrantApplicationDetail(id);

  if (!detail.application) {
    notFound();
  }

  const application = detail.application;
  const sourceEvidence = detail.sources.filter((source) => source.source_kind !== "forum_link");

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
          <MetricLabel body={detailHelp.applicant} label="Applicant" text="Applicant" />
          <strong>{application.applicant_name ?? "Unknown"}</strong>
        </article>
        <article className="metric-card">
          <MetricLabel body={detailHelp.status} label="Status" text="Status" />
          <strong>{application.normalized_status}</strong>
        </article>
        <article className="metric-card">
          <MetricLabel body={detailHelp.requested} label="Requested" text="Requested" />
          <strong>{moneyText(application.requested_amount_usd)}</strong>
        </article>
        <article className="metric-card">
          <MetricLabel body={detailHelp.sourceState} label="Source state" text="Source state" />
          <strong>{sourceProfileLabel(application.source_profile)}</strong>
        </article>
        <article className="metric-card">
          <MetricLabel body={detailHelp.match} label="GitHub-Sheet match" text="GitHub-Sheet match" />
          <strong>{matchText(application)}</strong>
        </article>
        <article className="metric-card">
          <MetricLabel body={detailHelp.forumLinks} label="Forum links" text="Forum links" />
          <strong>{numberText(application.forum_link_count)}</strong>
        </article>
        <article className="metric-card">
          <MetricLabel body={detailHelp.githubLabels} label="GitHub labels" text="GitHub labels" />
          <strong>{numberText(application.github_label_count)}</strong>
        </article>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>GitHub workflow labels</h2>
            <span className="section-count">
              {numberText(application.github_label_count)} label{application.github_label_count === "1" ? "" : "s"} captured as structured grant attributes
              <MetricHelp align="left" body={detailHelp.githubLabelSection} label="GitHub workflow label count" />
            </span>
          </div>
        </div>
        {detail.githubLabels.length ? (
          <div className="github-label-grid">
            {detail.githubLabels.map((label) => (
              <article className="github-label-card" key={label.label_name}>
                <span
                  className={`github-label-chip ${label.label_category}`}
                  style={githubLabelStyle(label)}
                  title={label.label_description ?? label.label_status ?? label.label_category}
                >
                  {label.label_name}
                </span>
                <dl className="evidence-meta">
                  <div>
                    <dt>Category</dt>
                    <dd>{statusLabel(label.label_category)}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{statusLabel(label.label_status)}</dd>
                  </div>
                  <div>
                    <dt>Milestone</dt>
                    <dd>{label.milestone_number ? numberText(label.milestone_number) : "-"}</dd>
                  </div>
                  <div>
                    <dt>Observed</dt>
                    <dd>{label.observed_at ? new Date(label.observed_at).toLocaleDateString("en-US") : "-"}</dd>
                  </div>
                </dl>
                {label.source_url ? (
                  <a className="table-link" href={label.source_url} rel="noreferrer" target="_blank">
                    Open GitHub issue
                  </a>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p>No GitHub labels captured for this application yet.</p>
        )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Forum links</h2>
            <span className="section-count">
              {numberText(application.forum_link_count)} forum thread{application.forum_link_count === "1" ? "" : "s"} associated with this application
              <MetricHelp align="left" body={detailHelp.forumLinkSection} label="Forum link count" />
            </span>
          </div>
        </div>
        <div className="evidence-list">
          {detail.forumLinks.length ? (
            detail.forumLinks.map((forumLink) => (
              <article className="evidence-item" key={forumLink.id}>
                <div>
                  <span className="badge neutral">Forum thread</span>
                  <h3>{forumLink.title ?? forumLink.source_id}</h3>
                  <p>{forumLink.summary ?? "Forum link discovered during source reconciliation."}</p>
                </div>
                <dl className="evidence-meta">
                  <div>
                    <dt>Confidence</dt>
                    <dd>{percentText(forumLink.confidence)}</dd>
                  </div>
                  <div>
                    <dt>Forum URL</dt>
                    <dd>{forumLink.source_id}</dd>
                  </div>
                </dl>
                {forumLink.source_url ? (
                  <a className="table-link" href={forumLink.source_url} rel="noreferrer" target="_blank">
                    Open forum thread
                  </a>
                ) : null}
                <p className="subtle">{compactJson(forumLink.metadata)}</p>
              </article>
            ))
          ) : (
            <p>No forum links identified for this application yet.</p>
          )}
        </div>
      </section>

      <section className="admin-grid two-column">
        <article className="panel">
          <div className="section-heading">
            <h2>Other source evidence</h2>
          </div>
          <div className="evidence-list">
            {sourceEvidence.map((source) => (
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
                  <a className="table-link" href={source.source_url} rel="noreferrer" target="_blank">
                    Open source record
                  </a>
                ) : null}
                <p className="subtle">{compactJson(source.metadata)}</p>
              </article>
            ))}
            {sourceEvidence.length ? null : <p>No non-forum source evidence recorded.</p>}
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
