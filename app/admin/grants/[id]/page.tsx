import type { CSSProperties } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getGrantApplicationDetail, type GitHubLabelRow, type GrantApplicationRow } from "@/lib/admin/dashboard";
import {
  isPublicPrototypePrincipal,
  principalHasPermission,
  principalHasRole,
  requirePermission
} from "@/lib/authorization";
import {
  COMMITTEE_BRIEFING_TEMPLATE_KEY,
  COMMITTEE_BRIEFING_TEMPLATE_VERSION,
  CUSTOM_GRANT_ANALYSIS_TEMPLATE_KEY,
  CUSTOM_GRANT_ANALYSIS_TEMPLATE_VERSION
} from "@/lib/knowledge/briefing";
import { knowledgeAiModel } from "@/lib/knowledge/config";
import {
  getGrantAnalysisReportFreshness,
  listGrantAnalysisReportEvidence,
  listGrantAnalysisReports
} from "@/lib/knowledge/reports";
import {
  GrantAnalysisPanel,
  type GrantAnalysisReport as ClientGrantAnalysisReport
} from "./grant-analysis-panel";
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

function dateOnlyText(value: string | null) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (!match) {
    return "Meeting date unknown";
  }

  const month = Number(match[2]);
  const day = Number(match[3]);
  const year = Number(match[1]);

  return Number.isFinite(month) && Number.isFinite(day) && Number.isFinite(year)
    ? `${month}/${day}/${year}`
    : "Meeting date unknown";
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

function forumRoleLabel(value: string | null) {
  if (value === "primary_forum_thread") {
    return "Primary forum thread";
  }

  if (value === "decision_minutes") {
    return "Decision minutes";
  }

  return "Supporting forum reference";
}

function parseSpeakerNotes(value: string | null | undefined): Array<{ speaker: string; note: string }> {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as Array<{ speaker: string; note: string }> : [];
  } catch {
    return [];
  }
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
  primaryForumThreads:
    "Count of forum_link source_records linked as the primary grant discussion thread, usually from an explicit Forum reference comment or All Grants Forum Link field.",
  supportingForumReferences:
    "Count of forum_link source_records linked as supporting context, such as prior funding, previous work, reports, dependencies, or background references.",
  githubLabels:
    "Count of GitHub issue labels captured as first-class grant_application_github_labels rows for this application.",
  decisionNotes:
    "Count of accepted grant_decision_mentions extracted from ZCG meeting minutes and linked to this canonical application.",
  decisionHistory:
    "Committee decision evidence parsed from ZCG meeting minutes in the Community Grants Updates forum category. These notes close the loop between application evidence and recorded ZCG outcomes.",
  githubLabelSection:
    "Structured labels copied from the GitHub issue during source mirroring and reconciliation. These are used for workflow/status filtering.",
  forumLinkSection:
    "Forum links discovered from GitHub comments, source payloads, or Sheet fields. Reconciliation classifies each as a primary forum thread or a supporting reference."
};

export default async function GrantApplicationPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const publicReadOptions = { allowPublicPrototypeRead: true };
  const principal = await requirePermission("grant:read", publicReadOptions);
  await requirePermission("source:mirror:read", publicReadOptions);
  await requirePermission("reconciliation:read", publicReadOptions);

  const { id } = await params;
  const detail = await getGrantApplicationDetail(id);

  if (!detail.application) {
    notFound();
  }

  const application = detail.application;
  const sourceEvidence = detail.sources.filter((source) => !["forum_link", "forum_meeting_minutes"].includes(source.source_kind));
  const primaryForumLinks = detail.forumLinks.filter((forumLink) => forumLink.relationship_role === "primary_forum_thread");
  const supportingForumLinks = detail.forumLinks.filter((forumLink) => forumLink.relationship_role !== "primary_forum_thread");
  let canReadAnalysis = false;
  let canGenerateAnalysis = false;
  let canPublishAnalysis = false;
  let initialAnalysisReports: ClientGrantAnalysisReport[] = [];

  if (!isPublicPrototypePrincipal(principal)) {
    const [canRead, canGenerate, canPublish, isAdmin] = await Promise.all([
      principalHasPermission(principal.id, "grant:analysis:read"),
      principalHasPermission(principal.id, "grant:analysis:generate"),
      principalHasPermission(principal.id, "grant:analysis:publish"),
      principalHasRole(principal.id, "admin")
    ]);
    canReadAnalysis = canRead;
    canGenerateAnalysis = canGenerate;
    canPublishAnalysis = canPublish;

    if (canReadAnalysis) {
      const reports = await listGrantAnalysisReports({
        applicationId: id,
        access: {
          principalId: principal.id,
          canReadAllPrivateReports: isAdmin
        }
      });

      initialAnalysisReports = await Promise.all(reports.map(async (report) => {
        const retrievalMode = report.generationMetadata.retrievalMode;
        const committeeBriefing = report.reportType === "committee_briefing";
        const [evidence, freshnessStatus] = await Promise.all([
          listGrantAnalysisReportEvidence(report.id),
          getGrantAnalysisReportFreshness({
            report,
            currentTemplateKey: committeeBriefing
              ? COMMITTEE_BRIEFING_TEMPLATE_KEY
              : CUSTOM_GRANT_ANALYSIS_TEMPLATE_KEY,
            currentTemplateVersion: committeeBriefing
              ? COMMITTEE_BRIEFING_TEMPLATE_VERSION
              : CUSTOM_GRANT_ANALYSIS_TEMPLATE_VERSION,
            currentModel: knowledgeAiModel()
          })
        ]);

        return {
          ...report,
          retrievalMode:
            retrievalMode === "keyword" || retrievalMode === "semantic" || retrievalMode === "hybrid"
              ? retrievalMode
              : null,
          freshnessStatus,
          evidence: evidence.map((item) => ({
            id: `${report.id}:${item.citationNumber}`,
            citationNumber: item.citationNumber,
            title: item.title ?? `Evidence ${item.citationNumber}`,
            excerpt: item.contentSnapshot,
            sourceKind: item.sourceKind,
            sourceId: item.sourceId,
            sourceUrl: item.sourceUrl,
            applicationId: item.applicationId,
            knowledgeDocumentId: item.knowledgeDocumentId,
            evidenceRole: item.evidenceRole,
            contentHash: item.contentHash
          }))
        };
      }));
    }
  }

  return (
    <main className="admin-shell">
      <section className="admin-header">
        <div>
          <p className="eyebrow">Canonical application</p>
          <h1>{application.title}</h1>
          <p className="lead">
            <Link className="table-link" href="/dashboard">
              Dashboard
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
          <MetricLabel body={detailHelp.primaryForumThreads} label="Primary forum threads" text="Primary forum" />
          <strong>{numberText(application.primary_forum_thread_count)}</strong>
        </article>
        <article className="metric-card">
          <MetricLabel body={detailHelp.supportingForumReferences} label="Supporting forum references" text="Supporting forum" />
          <strong>{numberText(application.supporting_forum_reference_count)}</strong>
        </article>
        <article className="metric-card">
          <MetricLabel body={detailHelp.githubLabels} label="GitHub labels" text="GitHub labels" />
          <strong>{numberText(application.github_label_count)}</strong>
        </article>
        <article className="metric-card">
          <MetricLabel body={detailHelp.decisionNotes} label="Decision notes" text="Decision notes" />
          <strong>{numberText(application.decision_mention_count)}</strong>
        </article>
      </section>

      <GrantAnalysisPanel
        applicationId={id}
        canGenerate={canGenerateAnalysis}
        canPublish={canPublishAnalysis}
        canRead={canReadAnalysis}
        initialReports={initialAnalysisReports}
      />

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
            <h2>Decision history</h2>
            <span className="section-count">
              {numberText(application.decision_mention_count)} meeting note{application.decision_mention_count === "1" ? "" : "s"} linked
              <MetricHelp align="left" body={detailHelp.decisionHistory} label="Decision history" />
            </span>
          </div>
        </div>
        <div className="evidence-list">
          {detail.decisionMentions.length ? (
            detail.decisionMentions.map((mention) => {
              const speakerNotes = parseSpeakerNotes(mention.speaker_notes);

              return (
                <article className="evidence-item decision-history-item" key={mention.id}>
                  <div>
                    <div className="issue-heading">
                      <span className={`badge ${mention.normalized_decision}`}>{statusLabel(mention.normalized_decision)}</span>
                      <span className="badge neutral">{dateOnlyText(mention.meeting_date)}</span>
                    </div>
                    <h3>{mention.candidate_title}</h3>
                    <p>{mention.decision_text ?? "Decision text was not parsed from the minutes."}</p>
                    {mention.rationale_text ? <p>{mention.rationale_text}</p> : null}
                  </div>
                  <dl className="evidence-meta">
                    <div>
                      <dt>Confidence</dt>
                      <dd>{percentText(mention.confidence)}</dd>
                    </div>
                    <div>
                      <dt>Match method</dt>
                      <dd>{statusLabel(mention.match_method)}</dd>
                    </div>
                    <div>
                      <dt>Minutes</dt>
                      <dd>{mention.meeting_title}</dd>
                    </div>
                  </dl>
                  {speakerNotes.length ? (
                    <details className="maintenance-callout">
                      <summary>Committee notes</summary>
                      <div className="evidence-list compact">
                        {speakerNotes.map((note, index) => (
                          <p key={`${note.speaker}-${index}`}>
                            <strong>{note.speaker}:</strong> {note.note}
                          </p>
                        ))}
                      </div>
                    </details>
                  ) : null}
                  <div className="link-row">
                    <a className="table-link" href={mention.topic_url} rel="noreferrer" target="_blank">
                      Open meeting minutes
                    </a>
                    {mention.linked_source_url ? (
                      <a className="table-link" href={mention.linked_source_url} rel="noreferrer" target="_blank">
                        Open referenced proposal
                      </a>
                    ) : null}
                  </div>
                </article>
              );
            })
          ) : (
            <p>No ZCG meeting-minute decision notes are linked to this application yet.</p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Forum links</h2>
            <span className="section-count">
              {numberText(application.primary_forum_thread_count)} primary, {numberText(application.supporting_forum_reference_count)} supporting
              <MetricHelp align="left" body={detailHelp.forumLinkSection} label="Forum link count" />
            </span>
          </div>
        </div>
        <div className="evidence-list">
          {primaryForumLinks.length ? (
            primaryForumLinks.map((forumLink) => (
              <article className="evidence-item" key={forumLink.id}>
                <div>
                  <span className={`badge ${forumLink.relationship_role}`}>{forumRoleLabel(forumLink.relationship_role)}</span>
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
            <p>No primary forum thread identified for this application yet.</p>
          )}
          {supportingForumLinks.map((forumLink) => (
            <article className="evidence-item" key={forumLink.id}>
              <div>
                <span className={`badge ${forumLink.relationship_role}`}>{forumRoleLabel(forumLink.relationship_role)}</span>
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
          ))}
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
