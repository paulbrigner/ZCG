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
import { grantAnalysisAiModel } from "@/lib/knowledge/config";
import {
  getGrantAnalysisReportFreshnessDetails,
  listGrantAnalysisReportEvidence,
  listGrantAnalysisReports
} from "@/lib/knowledge/reports";
import {
  GrantAnalysisPanel,
  type GrantAnalysisReport as ClientGrantAnalysisReport
} from "./grant-analysis-panel";
import { MetricHelp } from "../../metric-help";

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

function summaryText(value: string | null, maxLength = 240) {
  const normalized = value?.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return null;
  }

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized;
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
  const primaryForum = primaryForumLinks.reduce<(typeof primaryForumLinks)[number] | null>(
    (best, candidate) => Number(candidate.confidence) > Number(best?.confidence ?? -1) ? candidate : best,
    null
  );
  const latestDecision = detail.decisionMentions[0] ?? null;
  const reviewLabels = detail.githubLabels.slice(0, 5);
  let canReadAnalysis = false;
  let canGenerateAnalysis = false;
  let canPublishAnalysis = false;
  let canReadAllPrivateReports = false;
  let initialAnalysisReports: ClientGrantAnalysisReport[] = [];
  const publicViewer = isPublicPrototypePrincipal(principal);

  if (publicViewer) {
    canReadAnalysis = true;
  } else {
    const [canRead, canGenerate, canPublish, isAdmin] = await Promise.all([
      principalHasPermission(principal.id, "grant:analysis:read"),
      principalHasPermission(principal.id, "grant:analysis:generate"),
      principalHasPermission(principal.id, "grant:analysis:publish"),
      principalHasRole(principal.id, "admin")
    ]);
    canReadAnalysis = canRead;
    canGenerateAnalysis = canGenerate;
    canPublishAnalysis = canPublish;
    canReadAllPrivateReports = isAdmin;
  }

  if (canReadAnalysis) {
    const reports = await listGrantAnalysisReports({
      applicationId: id,
      access: {
        principalId: publicViewer ? null : principal.id,
        canReadAllPrivateReports
      },
      reportType: publicViewer ? "committee_briefing" : undefined
    });
    const visibleReports = publicViewer
      ? reports.filter((report) =>
          report.visibility === "shared" && report.status === "succeeded" && Boolean(report.answerText)
        )
      : reports;

    initialAnalysisReports = await Promise.all(visibleReports.map(async (report) => {
        const retrievalMode = report.generationMetadata.retrievalMode;
        const committeeBriefing = report.reportType === "committee_briefing";
        const [evidence, freshnessDetails] = await Promise.all([
          listGrantAnalysisReportEvidence(report.id),
          getGrantAnalysisReportFreshnessDetails({
            report,
            currentTemplateKey: committeeBriefing
              ? COMMITTEE_BRIEFING_TEMPLATE_KEY
              : CUSTOM_GRANT_ANALYSIS_TEMPLATE_KEY,
            currentTemplateVersion: committeeBriefing
              ? COMMITTEE_BRIEFING_TEMPLATE_VERSION
              : CUSTOM_GRANT_ANALYSIS_TEMPLATE_VERSION,
            currentModel: grantAnalysisAiModel(report.reportType)
          })
        ]);

        return {
          ...report,
          retrievalMode:
            retrievalMode === "keyword" || retrievalMode === "semantic" || retrievalMode === "hybrid"
              ? retrievalMode
              : null,
          freshnessStatus: freshnessDetails.status,
          freshnessDetails,
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
            contentHash: item.contentHash,
            changeStatus: item.changeStatus
          }))
        };
    }));
  }

  return (
    <main className="admin-shell">
      <section className="admin-header grant-detail-header">
        <div>
          <Link className="table-link grant-detail-back-link" href="/dashboard">
            Back to applications
          </Link>
          <p className="eyebrow">Grant application</p>
          <h1>{application.title}</h1>
        </div>
      </section>

      <section aria-labelledby="application-evaluation-heading" className="panel application-evaluation-summary">
        <div className="application-evaluation-heading">
          <div>
            <p className="eyebrow">Evaluation snapshot</p>
            <h2 id="application-evaluation-heading">Request at a glance</h2>
          </div>
          {application.github_issue_url || primaryForum?.source_url ? (
            <nav aria-label="Primary application sources" className="application-evaluation-actions">
              {application.github_issue_url ? (
                <a className="detail-action-link primary" href={application.github_issue_url} rel="noreferrer" target="_blank">
                  Open application source
                </a>
              ) : null}
              {primaryForum?.source_url ? (
                <a className="detail-action-link" href={primaryForum.source_url} rel="noreferrer" target="_blank">
                  Open forum discussion
                </a>
              ) : null}
            </nav>
          ) : null}
        </div>

        <dl className="application-evaluation-facts">
          <div>
            <dt>Applicant</dt>
            <dd>{application.applicant_name ?? "Unknown"}</dd>
          </div>
          <div>
            <dt>Requested</dt>
            <dd>{moneyText(application.requested_amount_usd)}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <span className={`badge ${application.normalized_status}`}>
                {statusLabel(application.normalized_status)}
              </span>
            </dd>
          </div>
          <div>
            <dt>Review context</dt>
            <dd>
              <span className={`badge ${primaryForum ? "neutral" : "warning"}`}>
                {primaryForum ? "Forum discussion linked" : "No primary forum linked"}
              </span>
              <small>
                {numberText(application.decision_mention_count)} committee record{application.decision_mention_count === "1" ? "" : "s"} linked
              </small>
            </dd>
          </div>
        </dl>
      </section>

      <GrantAnalysisPanel
        applicationId={id}
        canGenerate={canGenerateAnalysis}
        canPublish={canPublishAnalysis}
        canRead={canReadAnalysis}
        initialReports={initialAnalysisReports}
      />

      <section aria-label="Current grant review signals" className="panel application-review-signals">
        <div className="application-review-signal">
          <span className="application-review-signal-label">Workflow signals</span>
          {reviewLabels.length ? (
            <div className="github-label-list">
              {reviewLabels.map((label) => (
                <span
                  className={`github-label-chip ${label.label_category}`}
                  key={label.label_name}
                  style={githubLabelStyle(label)}
                  title={label.label_description ?? label.label_status ?? label.label_category}
                >
                  {label.label_name}
                </span>
              ))}
              {detail.githubLabels.length > reviewLabels.length ? (
                <span className="github-label-chip overflow">
                  +{numberText(detail.githubLabels.length - reviewLabels.length)} more
                </span>
              ) : null}
            </div>
          ) : <p>No structured workflow signals are recorded.</p>}
        </div>

        <div className="application-review-signal">
          <span className="application-review-signal-label">Latest committee record</span>
          {latestDecision ? (
            <div className="application-decision-signal">
              <div className="issue-heading">
                <span className={`badge ${latestDecision.normalized_decision}`}>
                  {statusLabel(latestDecision.normalized_decision)}
                </span>
                <span className="badge neutral">{dateOnlyText(latestDecision.meeting_date)}</span>
              </div>
              <p>
                {summaryText(latestDecision.rationale_text ?? latestDecision.decision_text) ??
                  "A linked committee record is available below."}
              </p>
            </div>
          ) : <p>No linked committee decision record yet.</p>}
        </div>
      </section>

      <details className="operations-disclosure application-operational-details">
        <summary>
          <span>Data quality and provenance</span>
          <small>Source matching, linked-record coverage, and reconciliation diagnostics</small>
        </summary>
        <div className="operations-disclosure-body">
          <section aria-labelledby="application-provenance-heading" className="panel">
            <div className="section-heading">
              <div>
                <h2 id="application-provenance-heading">Source coverage</h2>
                <span className="section-count">Operational context for tracing how this canonical record was assembled.</span>
              </div>
            </div>
            <div className="source-counts compact-source-counts application-operational-metrics">
              <div className="source-count">
                <span className="count-with-help">
                  Source state
                  <MetricHelp align="left" body={detailHelp.sourceState} label="Source state" />
                </span>
                <strong>{sourceProfileLabel(application.source_profile)}</strong>
              </div>
              <div className="source-count">
                <span className="count-with-help">
                  GitHub-Sheet match
                  <MetricHelp align="left" body={detailHelp.match} label="GitHub-Sheet match" />
                </span>
                <strong>{matchText(application)}</strong>
              </div>
              <div className="source-count">
                <span className="count-with-help">
                  Primary forum
                  <MetricHelp align="left" body={detailHelp.primaryForumThreads} label="Primary forum threads" />
                </span>
                <strong>{numberText(application.primary_forum_thread_count)}</strong>
              </div>
              <div className="source-count">
                <span className="count-with-help">
                  Supporting forum
                  <MetricHelp align="left" body={detailHelp.supportingForumReferences} label="Supporting forum references" />
                </span>
                <strong>{numberText(application.supporting_forum_reference_count)}</strong>
              </div>
              <div className="source-count">
                <span className="count-with-help">
                  GitHub labels
                  <MetricHelp align="left" body={detailHelp.githubLabels} label="GitHub labels" />
                </span>
                <strong>{numberText(application.github_label_count)}</strong>
              </div>
              <div className="source-count">
                <span className="count-with-help">
                  Decision notes
                  <MetricHelp align="left" body={detailHelp.decisionNotes} label="Decision notes" />
                </span>
                <strong>{numberText(application.decision_mention_count)}</strong>
              </div>
            </div>
          </section>

          {!publicViewer ? (
            <section aria-labelledby="application-reconciliation-heading" className="panel">
              <div className="section-heading">
                <div>
                  <h2 id="application-reconciliation-heading">Reconciliation issues</h2>
                  <span className="section-count">
                    {numberText(application.open_issue_count)} open issue{application.open_issue_count === "1" ? "" : "s"}
                  </span>
                </div>
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
            </section>
          ) : null}
        </div>
      </details>

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

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Application source evidence</h2>
            <span className="section-count">Primary GitHub, Sheet, and other non-forum source records.</span>
          </div>
        </div>
        <div className="evidence-list">
          {sourceEvidence.map((source) => (
            <article className="evidence-item" key={source.id}>
              <div>
                <span className="badge neutral">{statusLabel(source.source_kind)}</span>
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
      </section>
    </main>
  );
}
