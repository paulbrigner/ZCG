"use client";

import { FormEvent, useMemo, useState } from "react";
import type {
  ReconciliationDecisionType,
  ReconciliationIssueReviewRow,
  ReconciliationWorkspace
} from "@/lib/reconciliation/decisions";
import { MetricHelp } from "./metric-help";

type ReconciliationManagementPanelProps = {
  initialWorkspace: ReconciliationWorkspace;
  canWrite: boolean;
};

type DecisionForm = {
  decisionType: ReconciliationDecisionType;
  reconciliationIssueId: string;
  sourceKind: string;
  sourceId: string;
  canonicalKey: string;
  relatedCanonicalKey: string;
  relationshipType: string;
  confidence: string;
  rationale: string;
  resolutionStatus: "resolved" | "dismissed";
};

const emptyForm: DecisionForm = {
  decisionType: "link_source",
  reconciliationIssueId: "",
  sourceKind: "",
  sourceId: "",
  canonicalKey: "",
  relatedCanonicalKey: "",
  relationshipType: "related_attempt",
  confidence: "1",
  rationale: "",
  resolutionStatus: "resolved"
};

const githubIssuePrefix = "ZcashCommunityGrants/zcashcommunitygrants#";

const helpText = {
  decisions:
    "Manual reconciliation decisions are durable reviewer inputs. They are replayed after automatic reconciliation so source links, issue resolutions, and application relationships survive rebuilds.",
  openIssues:
    "Generated reconciliation issues are the work queue. Resolving one should create a durable manual decision when the resolution depends on reviewer judgment.",
  relationships:
    "Application relationships are derived from active manual decisions, such as related attempts, resubmissions, or same-grant links."
};

async function postDecision(body: Record<string, unknown>) {
  const response = await fetch("/api/admin/reconciliations/decisions", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(String(payload?.error ?? "Failed to update reconciliation decisions."));
  }

  return payload as { workspace: ReconciliationWorkspace };
}

function numberText(value: string | number | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US") : "0";
}

function dateText(value: string | null | undefined) {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "-" : parsed.toLocaleString();
}

function titleText(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseDetails(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function suggestedGitHubSourceId(issue: ReconciliationIssueReviewRow) {
  const details = parseDetails(issue.details);
  const issueNumber = details.githubIssueNumber;

  if (typeof issueNumber === "number" || typeof issueNumber === "string") {
    const parsed = Number(issueNumber);
    return Number.isFinite(parsed) ? `${githubIssuePrefix}${parsed}` : "";
  }

  return "";
}

function linkedIssuesText(value: string | null) {
  if (!value) {
    return "[]";
  }

  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

export function ReconciliationManagementPanel({ initialWorkspace, canWrite }: ReconciliationManagementPanelProps) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [form, setForm] = useState<DecisionForm>(emptyForm);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const activeIssue = useMemo(
    () => workspace.openIssues.find((issue) => issue.id === form.reconciliationIssueId),
    [form.reconciliationIssueId, workspace.openIssues]
  );

  function updateForm(patch: Partial<DecisionForm>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function prepareSourceLink(issue: ReconciliationIssueReviewRow) {
    updateForm({
      decisionType: "link_source",
      reconciliationIssueId: issue.id,
      sourceKind: suggestedGitHubSourceId(issue) ? "github_issue" : issue.sourceKind ?? "",
      sourceId: suggestedGitHubSourceId(issue) || issue.sourceId || "",
      canonicalKey: issue.canonicalKey ?? "",
      relatedCanonicalKey: "",
      relationshipType: "related_attempt",
      resolutionStatus: "resolved",
      rationale: issue.canonicalTitle
        ? `Manual review confirms this source belongs with ${issue.canonicalTitle}.`
        : "Manual review confirms this source link."
    });
  }

  function prepareDismissal(issue: ReconciliationIssueReviewRow) {
    updateForm({
      decisionType: "dismiss_issue",
      reconciliationIssueId: issue.id,
      sourceKind: issue.sourceKind ?? "",
      sourceId: issue.sourceId ?? "",
      canonicalKey: issue.canonicalKey ?? "",
      relatedCanonicalKey: "",
      resolutionStatus: "dismissed",
      rationale: "Manual review determined this generated issue does not require a data change."
    });
  }

  async function submitDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    setError("");

    try {
      const result = await postDecision({
        action: "create_decision",
        decisionType: form.decisionType,
        reconciliationIssueId: form.reconciliationIssueId || null,
        sourceKind: form.sourceKind || null,
        sourceId: form.sourceId || null,
        canonicalKey: form.canonicalKey || null,
        relatedCanonicalKey: form.relatedCanonicalKey || null,
        relationshipType: form.relationshipType || null,
        confidence: form.confidence ? Number(form.confidence) : 1,
        rationale: form.rationale,
        resolutionStatus: form.resolutionStatus
      });
      setWorkspace(result.workspace);
      setMessage("Manual reconciliation decision saved and applied.");
      setForm(emptyForm);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to save reconciliation decision.");
    } finally {
      setPending(false);
    }
  }

  async function applyDecisions() {
    setPending(true);
    setMessage("");
    setError("");

    try {
      const result = await postDecision({ action: "apply_manual_decisions" });
      setWorkspace(result.workspace);
      setMessage("Active manual decisions reapplied.");
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Failed to apply manual decisions.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="reconciliation-workspace">
      <section className="metric-grid" aria-label="Reconciliation summary">
        <article className="metric-card">
          <span className="metric-label">Open issues</span>
          <strong>{numberText(workspace.summary.openIssueCount)}</strong>
        </article>
        <article className="metric-card">
          <span className="metric-label">
            Active decisions
            <MetricHelp align="left" body={helpText.decisions} label="Active decisions" />
          </span>
          <strong>{numberText(workspace.summary.activeDecisionCount)}</strong>
        </article>
        <article className="metric-card">
          <span className="metric-label">
            Relationships
            <MetricHelp align="left" body={helpText.relationships} label="Application relationships" />
          </span>
          <strong>{numberText(workspace.summary.relationshipCount)}</strong>
        </article>
        <article className="metric-card">
          <span className="metric-label">Issue-linked decisions</span>
          <strong>{numberText(workspace.summary.linkedIssueDecisionCount)}</strong>
        </article>
      </section>

      {canWrite ? (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Create manual decision</h2>
              <span className="section-count">Durable reviewer input replayed after generated reconciliation</span>
            </div>
            <button className="ghost-button" disabled={pending} onClick={applyDecisions} type="button">
              Reapply decisions
            </button>
          </div>

          <form className="reconciliation-decision-form" onSubmit={submitDecision}>
            <label className="search-field compact-field">
              <span>Decision</span>
              <select
                onChange={(event) => updateForm({ decisionType: event.target.value as ReconciliationDecisionType })}
                value={form.decisionType}
              >
                <option value="link_source">Link source</option>
                <option value="unlink_source">Unlink source</option>
                <option value="relate_applications">Relate applications</option>
                <option value="merge_applications">Same grant</option>
                <option value="dismiss_issue">Dismiss issue</option>
              </select>
            </label>
            <label className="search-field">
              <span>Issue ID</span>
              <input
                onChange={(event) => updateForm({ reconciliationIssueId: event.target.value })}
                placeholder="Optional reconciliation_issues UUID"
                type="text"
                value={form.reconciliationIssueId}
              />
            </label>
            <label className="search-field compact-field">
              <span>Resolution</span>
              <select
                onChange={(event) => updateForm({ resolutionStatus: event.target.value as "resolved" | "dismissed" })}
                value={form.resolutionStatus}
              >
                <option value="resolved">Resolved</option>
                <option value="dismissed">Dismissed</option>
              </select>
            </label>
            <label className="search-field compact-field">
              <span>Source kind</span>
              <input
                onChange={(event) => updateForm({ sourceKind: event.target.value })}
                placeholder="github_issue"
                type="text"
                value={form.sourceKind}
              />
            </label>
            <label className="search-field">
              <span>Source ID</span>
              <input
                onChange={(event) => updateForm({ sourceId: event.target.value })}
                placeholder="ZcashCommunityGrants/zcashcommunitygrants#82"
                type="text"
                value={form.sourceId}
              />
            </label>
            <label className="search-field">
              <span>Canonical key</span>
              <input
                onChange={(event) => updateForm({ canonicalKey: event.target.value })}
                placeholder="sheet-all-grants:..."
                type="text"
                value={form.canonicalKey}
              />
            </label>
            <label className="search-field">
              <span>Related canonical key</span>
              <input
                onChange={(event) => updateForm({ relatedCanonicalKey: event.target.value })}
                placeholder="Required for application relationships"
                type="text"
                value={form.relatedCanonicalKey}
              />
            </label>
            <label className="search-field compact-field">
              <span>Relationship</span>
              <input
                onChange={(event) => updateForm({ relationshipType: event.target.value })}
                placeholder="related_attempt"
                type="text"
                value={form.relationshipType}
              />
            </label>
            <label className="search-field compact-field">
              <span>Confidence</span>
              <input
                max="1"
                min="0"
                onChange={(event) => updateForm({ confidence: event.target.value })}
                step="0.01"
                type="number"
                value={form.confidence}
              />
            </label>
            <label className="search-field reconciliation-rationale-field">
              <span>Rationale</span>
              <textarea
                onChange={(event) => updateForm({ rationale: event.target.value })}
                placeholder="Explain the reviewer judgment and evidence."
                required
                value={form.rationale}
              />
            </label>
            <div className="form-actions">
              <button disabled={pending || !canWrite} type="submit">
                Save decision
              </button>
            </div>
          </form>

          {activeIssue ? (
            <p className="form-status">
              Selected issue: {activeIssue.issueType} | {activeIssue.summary}
            </p>
          ) : null}
          {message ? <p className="form-status">{message}</p> : null}
          {error ? <p className="form-error">{error}</p> : null}
        </section>
      ) : (
        <section className="panel">
          <h2>Manual decisions</h2>
          <p className="lead">Sign in with reconciliation write access to create durable manual decisions.</p>
        </section>
      )}

      <section className="panel">
        <div className="section-heading">
          <h2>
            Open reconciliation issues
            <MetricHelp align="left" body={helpText.openIssues} label="Open reconciliation issues" />
          </h2>
        </div>
        <div className="reconciliation-list">
          {workspace.openIssues.length ? (
            workspace.openIssues.map((issue) => (
              <article className="reconciliation-card" key={issue.id}>
                <div className="reconciliation-card-header">
                  <div>
                    <span className={`badge ${issue.severity}`}>{issue.severity}</span>
                    <span className={`badge ${issue.status}`}>{issue.status}</span>
                  </div>
                  <span className="subtle">{dateText(issue.createdAt)}</span>
                </div>
                <h3>{issue.summary}</h3>
                <p className="subtle">{titleText(issue.issueType)}</p>
                <dl className="reconciliation-facts">
                  <div>
                    <dt>Source</dt>
                    <dd>{issue.sourceKind && issue.sourceId ? `${issue.sourceKind}:${issue.sourceId}` : "-"}</dd>
                  </div>
                  <div>
                    <dt>Canonical</dt>
                    <dd>{issue.canonicalKey ?? "-"}</dd>
                  </div>
                  <div>
                    <dt>Application</dt>
                    <dd>{issue.canonicalTitle ?? "-"}</dd>
                  </div>
                </dl>
                <details>
                  <summary>Issue details</summary>
                  <pre className="json-block">{JSON.stringify(parseDetails(issue.details), null, 2)}</pre>
                </details>
                {canWrite ? (
                  <div className="form-actions">
                    <button className="ghost-button" disabled={pending} onClick={() => prepareSourceLink(issue)} type="button">
                      Use for source link
                    </button>
                    <button className="ghost-button" disabled={pending} onClick={() => prepareDismissal(issue)} type="button">
                      Dismiss
                    </button>
                  </div>
                ) : null}
              </article>
            ))
          ) : (
            <p>No open reconciliation issues.</p>
          )}
        </div>
      </section>

      <section className="admin-grid two-column">
        <article className="panel">
          <div className="section-heading">
            <h2>
              Manual decisions
              <MetricHelp align="left" body={helpText.decisions} label="Manual decisions" />
            </h2>
          </div>
          <div className="reconciliation-list compact">
            {workspace.decisions.length ? (
              workspace.decisions.map((decision) => (
                <article className="reconciliation-card compact" key={decision.id}>
                  <div className="reconciliation-card-header">
                    <span className={`badge ${decision.status}`}>{decision.status}</span>
                    <span className="subtle">{dateText(decision.updatedAt)}</span>
                  </div>
                  <h3>{titleText(decision.decisionType)}</h3>
                  <p>{decision.rationale}</p>
                  <dl className="reconciliation-facts">
                    <div>
                      <dt>Decision key</dt>
                      <dd>{decision.decisionKey}</dd>
                    </div>
                    <div>
                      <dt>Source</dt>
                      <dd>{decision.sourceKind && decision.sourceId ? `${decision.sourceKind}:${decision.sourceId}` : "-"}</dd>
                    </div>
                    <div>
                      <dt>Canonical</dt>
                      <dd>{decision.canonicalKey ?? "-"}</dd>
                    </div>
                    <div>
                      <dt>Related</dt>
                      <dd>{decision.relatedCanonicalKey ?? "-"}</dd>
                    </div>
                    <div>
                      <dt>Reviewer</dt>
                      <dd>{decision.createdByEmail ?? "-"}</dd>
                    </div>
                  </dl>
                  <details>
                    <summary>Linked issues</summary>
                    <pre className="json-block">{linkedIssuesText(decision.linkedIssues)}</pre>
                  </details>
                </article>
              ))
            ) : (
              <p>No manual decisions recorded yet.</p>
            )}
          </div>
        </article>

        <article className="panel">
          <div className="section-heading">
            <h2>
              Application relationships
              <MetricHelp align="left" body={helpText.relationships} label="Application relationships" />
            </h2>
          </div>
          <div className="reconciliation-list compact">
            {workspace.relationships.length ? (
              workspace.relationships.map((relationship) => (
                <article className="reconciliation-card compact" key={relationship.relationshipKey}>
                  <div className="reconciliation-card-header">
                    <span className="badge neutral">{titleText(relationship.relationshipType)}</span>
                    <span className="subtle">{dateText(relationship.updatedAt)}</span>
                  </div>
                  <h3>{relationship.fromTitle}</h3>
                  <p className="subtle">Related to {relationship.toTitle}</p>
                  <dl className="reconciliation-facts">
                    <div>
                      <dt>From</dt>
                      <dd>{relationship.fromCanonicalKey}</dd>
                    </div>
                    <div>
                      <dt>To</dt>
                      <dd>{relationship.toCanonicalKey}</dd>
                    </div>
                    <div>
                      <dt>Decision</dt>
                      <dd>{relationship.sourceDecisionKey ?? "-"}</dd>
                    </div>
                  </dl>
                  {relationship.rationale ? <p>{relationship.rationale}</p> : null}
                </article>
              ))
            ) : (
              <p>No application relationships recorded yet.</p>
            )}
          </div>
        </article>
      </section>
    </div>
  );
}
