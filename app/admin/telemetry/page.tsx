import Link from "next/link";
import { getAdminDashboard } from "@/lib/admin/dashboard";
import { principalHasRole, requirePermission } from "@/lib/authorization";
import { knowledgeProviderStatus } from "@/lib/knowledge/config";
import { getGrantKnowledgeOverview } from "@/lib/knowledge/search";
import { fundedGrantMetricHelp } from "../../grant-metric-copy";
import { MetricHelp, MetricLabel } from "../metric-help";

function numberText(value: string | number | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US") : "0";
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

function embeddingBacklogText(count: number) {
  return count === 0 ? "Caught up" : `${numberText(count)} remaining`;
}

function lastEmbeddingRunText({
  action,
  createdAt,
  embedded,
  skipped
}: {
  action: string | null;
  createdAt: string | null;
  embedded: number | null;
  skipped: number | null;
}) {
  if (!createdAt) {
    return "No embedding run recorded yet.";
  }

  const source = action === "knowledge.embed.scheduled"
    ? "scheduled"
    : action === "knowledge.embed.scheduled.failed"
      ? "scheduled failed"
      : "manual";
  const embeddedText = embedded === null ? "" : `; ${numberText(embedded)} embedded`;
  const skippedText = skipped ? `; ${numberText(skipped)} skipped` : "";

  return `Last ${source} run: ${dateText(createdAt)}${embeddedText}${skippedText}`;
}

const telemetryHelp = {
  sourceRecords:
    "Sum of mirrored and derived evidence rows from Google Sheets, GitHub, and the Zcash Community Forum.",
  canonicalApplications:
    "Grant applications after the source records have been reconciled into one application view.",
  canonicalGrants:
    fundedGrantMetricHelp,
  openReconciliation:
    "Open reconciliation items that still need review or confirmation.",
  syncSeen:
    "Source records observed during the synchronization run.",
  syncUpdated:
    "Source records created or updated during the synchronization run.",
  sourceKind:
    "Source records grouped by their source type, with the most recent update time.",
  reconciliationGroup:
    "Reconciliation items grouped by status and severity.",
  matched:
    "Applications supported by both GitHub and Google Sheet evidence.",
  githubOnly:
    "Applications with GitHub evidence but no matched Google Sheet record.",
  sheetOnly:
    "Applications with Google Sheet evidence but no linked GitHub issue.",
  primaryForumThreads:
    "Forum discussions identified as the primary thread for an application.",
  supportingForumReferences:
    "Forum links retained as supporting background or related evidence.",
  documents:
    "Searchable knowledge documents built from canonical applications and their linked source records.",
  applications:
    "Applications represented in the searchable knowledge corpus.",
  latestIndex:
    "Most recent time the searchable knowledge corpus was updated.",
  embeddings:
    "Knowledge documents with a current semantic embedding.",
  embeddingBacklog:
    "Knowledge documents that still need a current semantic embedding.",
  aiAnswers:
    "Whether the grounded answer provider is configured.",
  indexedSource:
    "Knowledge documents grouped by source or document type."
};

export default async function TelemetryPage() {
  const principal = await requirePermission("source:mirror:read");
  await requirePermission("reconciliation:read");
  const [telemetry, canManageUsers, knowledgeOverview, providerStatus] = await Promise.all([
    getAdminDashboard(),
    principalHasRole(principal.id, "admin"),
    getGrantKnowledgeOverview(),
    Promise.resolve(knowledgeProviderStatus())
  ]);
  const totals = telemetry.applicationTotals;
  const totalSourceRecords = telemetry.sourceCounts.reduce(
    (total, row) => total + Number(row.record_count),
    0
  );
  const openReconciliationIssues = telemetry.reconciliationSummary
    .filter((row) => row.status === "open")
    .reduce((total, row) => total + Number(row.issue_count), 0);
  const forumRoleTotals = telemetry.forumRoleTotals;

  return (
    <main className="admin-shell">
      <section className="admin-header">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>Telemetry</h1>
          <p className="lead">
            Sync, source, reconciliation, and system status. <Link className="table-link" href="/dashboard">Dashboard</Link>
          </p>
        </div>
      </section>

      <section className="metric-grid" aria-label="Operational summary">
        <article className="metric-card">
          <MetricLabel body={telemetryHelp.sourceRecords} label="Source records" text="Source records" />
          <strong>{numberText(totalSourceRecords)}</strong>
        </article>
        <article className="metric-card">
          <MetricLabel body={telemetryHelp.canonicalApplications} label="Canonical applications" text="Canonical applications" />
          <strong>{numberText(totals.total_applications)}</strong>
          <span className="metric-note">Total normalized application records</span>
        </article>
        <article className="metric-card">
          <MetricLabel body={telemetryHelp.canonicalGrants} label="Funded-status grants" text="Funded-status grants" />
          <strong>{numberText(totals.total_grants)}</strong>
          <span className="metric-note">Current canonical grant records</span>
        </article>
        <article className="metric-card">
          <MetricLabel body={telemetryHelp.openReconciliation} label="Open reconciliation" text="Open reconciliation" />
          <strong>{numberText(openReconciliationIssues)}</strong>
          <span className="metric-note">Items needing review or confirmation</span>
        </article>
      </section>

      <section className="panel" aria-labelledby="corpus-status-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Knowledge operations</p>
            <h2 id="corpus-status-heading">Corpus and index status</h2>
          </div>
        </div>
        <section className="metric-grid knowledge-metric-grid" aria-label="Grant knowledge summary">
          <article className="metric-card">
            <MetricLabel body={telemetryHelp.documents} label="Knowledge documents" text="Knowledge documents" />
            <strong>{numberText(knowledgeOverview.documentCount)}</strong>
          </article>
          <article className="metric-card">
            <MetricLabel body={telemetryHelp.applications} label="Applications covered" text="Applications covered" />
            <strong>{numberText(knowledgeOverview.applicationCount)}</strong>
          </article>
          <article className="metric-card">
            <MetricLabel body={telemetryHelp.latestIndex} label="Latest index" text="Latest index" />
            <strong>{dateText(knowledgeOverview.latestIndexedAt)}</strong>
          </article>
          <article className="metric-card">
            <MetricLabel body={telemetryHelp.embeddings} label="Embeddings" text="Embeddings" />
            <strong>{numberText(knowledgeOverview.embeddingCount)}</strong>
            <span className="metric-note">
              {providerStatus.embeddingModel} · {numberText(knowledgeOverview.documentCount)} total
            </span>
          </article>
          <article className="metric-card">
            <MetricLabel body={telemetryHelp.embeddingBacklog} label="Embedding backlog" text="Embedding backlog" />
            <strong>{embeddingBacklogText(knowledgeOverview.embeddingBacklogCount)}</strong>
            <span className="metric-note">
              {lastEmbeddingRunText({
                action: knowledgeOverview.lastEmbeddingRunAction,
                createdAt: knowledgeOverview.lastEmbeddingRunAt,
                embedded: knowledgeOverview.lastEmbeddingRunDocumentsEmbedded,
                skipped: knowledgeOverview.lastEmbeddingRunDocumentsSkipped
              })}
            </span>
          </article>
          <article className="metric-card">
            <MetricLabel body={telemetryHelp.aiAnswers} label="AI answers" text="AI answers" />
            <strong>{providerStatus.aiConfigured ? "Configured" : "Not set"}</strong>
            <span className="metric-note">{providerStatus.aiModel}</span>
          </article>
        </section>
        <div className="source-counts compact-source-counts telemetry-indexed-sources">
          {knowledgeOverview.sourceKinds.length ? knowledgeOverview.sourceKinds.map((sourceKind) => (
            <div className="source-count" key={sourceKind.sourceKind}>
              <span>
                {sourceKind.sourceKind}
                <MetricHelp align="left" body={telemetryHelp.indexedSource} label={`${sourceKind.sourceKind} knowledge documents`} />
              </span>
              <strong>{numberText(sourceKind.documentCount)}</strong>
            </div>
          )) : <p>No knowledge documents indexed yet.</p>}
        </div>
      </section>

      <section className="admin-grid two-column">
        <article className="panel">
          <div className="section-heading"><h2>Sync runs</h2></div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Status</th>
                  <th><span className="table-heading-with-help">Seen<MetricHelp body={telemetryHelp.syncSeen} label="Sync records seen" /></span></th>
                  <th><span className="table-heading-with-help">Updated<MetricHelp body={telemetryHelp.syncUpdated} label="Sync records updated" /></span></th>
                  <th>Completed</th>
                </tr>
              </thead>
              <tbody>
                {telemetry.syncRuns.map((run) => (
                  <tr key={run.id}>
                    <td>{run.source}</td>
                    <td><span className={`badge ${run.status}`}>{run.status}</span></td>
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
            <h2>Source records <MetricHelp body={telemetryHelp.sourceKind} label="Source record counts" /></h2>
          </div>
          <div className="source-counts">
            {telemetry.sourceCounts.map((row) => (
              <div className="source-count" key={row.source_kind}>
                <span>{row.source_kind}<MetricHelp align="left" body={telemetryHelp.sourceKind} label={`${row.source_kind} records`} /></span>
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
            <h2>Reconciliation <MetricHelp body={telemetryHelp.reconciliationGroup} label="Reconciliation counts" /></h2>
          </div>
          <div className="status-list">
            {telemetry.reconciliationSummary.length ? telemetry.reconciliationSummary.map((row) => (
              <p className="status-item" key={`${row.status}-${row.severity}`}>
                <span className={`dot ${row.severity === "error" ? "red" : row.severity === "warning" ? "amber" : "blue"}`} />
                <span>{row.status}</span>
                <span>{row.severity}</span>
                <strong>{numberText(row.issue_count)}</strong>
              </p>
            )) : <p>No reconciliation issues recorded.</p>}
          </div>
        </article>

        <article className="panel">
          <div className="section-heading"><h2>Source coverage</h2></div>
          <div className="status-list">
            <p className="status-item"><span className="dot green" />Matched GitHub + Sheet records<strong>{numberText(totals.matched_applications)}</strong></p>
            <p className="status-item"><span className="dot amber" />GitHub-only records<strong>{numberText(totals.github_only_applications)}</strong></p>
            <p className="status-item"><span className="dot amber" />Sheet-only records<strong>{numberText(totals.sheet_only_applications)}</strong></p>
            <p className="status-item"><span className="dot blue" />Primary forum threads<strong>{numberText(forumRoleTotals.primary_forum_threads)}</strong></p>
            <p className="status-item"><span className="dot blue" />Supporting forum references<strong>{numberText(forumRoleTotals.supporting_forum_references)}</strong></p>
            <p className="status-item"><span className="dot blue" />Manual reconciliation workspace<Link className="table-link" href="/admin/reconciliations">Open</Link></p>
            {canManageUsers ? (
              <p className="status-item"><span className="dot blue" />User access management<Link className="table-link" href="/admin/users">Open</Link></p>
            ) : null}
          </div>
        </article>
      </section>
    </main>
  );
}
