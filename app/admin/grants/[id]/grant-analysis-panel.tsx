"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { linkEvidenceCitationsInMarkdown } from "../../../../lib/knowledge/presentation";
import styles from "./grant-analysis-panel.module.css";

export type GrantAnalysisReportType = "committee_briefing" | "custom";
export type GrantAnalysisVisibility = "temporary" | "private" | "shared";
export type GrantAnalysisStatus = "queued" | "running" | "succeeded" | "failed";
export type GrantAnalysisRetrievalMode = "keyword" | "semantic" | "hybrid";

export type GrantAnalysisEvidence = {
  id: string;
  citationNumber: number;
  title: string;
  excerpt?: string | null;
  sourceKind?: string | null;
  sourceId?: string | null;
  sourceUrl?: string | null;
  applicationId?: string | null;
  knowledgeDocumentId?: string | null;
  evidenceRole?: string | null;
  contentHash?: string | null;
  changeStatus?: "current" | "changed" | "missing" | null;
};

export type GrantAnalysisPromptPacking = {
  configVersion: string | null;
  candidateCount: number;
  selectedCount: number;
  renderedChars: number;
  promptBudgetChars: number;
  truncatedCount: number;
  currentApplicationRenderedRatio: number;
  currentApplicationTargetMet: boolean | null;
  primaryForum: {
    linked: boolean;
    candidateRecords: number;
    selectedRecords: number;
    availablePostCount: number;
    packedPostCount: number;
    omittedPostCount: number;
  };
};

export type GrantAnalysisFreshnessDetails = {
  status: "fresh" | "stale" | "unknown";
  evidenceStatus: "current" | "changed" | "unknown";
  evidenceRecordCount: number;
  changedEvidenceRecordCount: number;
  templateChanged: boolean;
  modelChanged: boolean;
};

export type GrantAnalysisReport = {
  id: string;
  applicationId: string;
  reportType: GrantAnalysisReportType;
  visibility: GrantAnalysisVisibility;
  status: GrantAnalysisStatus;
  title: string;
  customPrompt?: string | null;
  answerText?: string | null;
  answerStatus?: string | null;
  errorMessage?: string | null;
  evidenceFingerprint?: string | null;
  currentEvidenceFingerprint?: string | null;
  isStale?: boolean | null;
  freshnessStatus?: "fresh" | "stale" | "unknown" | null;
  freshnessDetails?: GrantAnalysisFreshnessDetails | null;
  templateKey?: string | null;
  templateVersion?: string | number | null;
  provider?: string | null;
  model?: string | null;
  retrievalMode?: GrantAnalysisRetrievalMode | null;
  version?: number | null;
  versionNumber?: number | null;
  requestedByDisplayName?: string | null;
  requestedByEmail?: string | null;
  supersedesReportId?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  completedAt?: string | null;
  evidence?: GrantAnalysisEvidence[];
  generationMetadata?: Record<string, unknown>;
  promptPacking?: GrantAnalysisPromptPacking | null;
};

export type GrantAnalysisPanelProps = {
  applicationId: string;
  initialReports: readonly GrantAnalysisReport[];
  canRead: boolean;
  canGenerate: boolean;
  committeeBriefingEligible: boolean;
  canPublish: boolean;
};

type JobStatus = "queued" | "running" | "succeeded" | "failed" | "expired";

type TemporaryAnalysis = {
  id: string;
  title: string;
  prompt: string;
  answerText: string;
  evidence: GrantAnalysisEvidence[];
  createdAt: string;
};

type ActiveOperation = "briefing" | "custom" | "refresh" | null;
type ReportActionFeedback = { kind: "success" | "error"; message: string } | null;

const defaultPollMs = 1500;
const defaultCommitteeBriefingPromptBudgetChars = 90_000;

function fallbackCopyText(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("The browser did not copy the briefing.");
    }
  } finally {
    textarea.remove();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function field(record: Record<string, unknown>, camel: string, snake?: string) {
  return record[camel] ?? (snake ? record[snake] : undefined);
}

function stringField(record: Record<string, unknown>, camel: string, snake?: string) {
  const value = field(record, camel, snake);
  return typeof value === "string" ? value : null;
}

function numberField(record: Record<string, unknown>, camel: string, snake?: string) {
  const value = field(record, camel, snake);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanField(record: Record<string, unknown>, camel: string, snake?: string) {
  const value = field(record, camel, snake);
  return typeof value === "boolean" ? value : null;
}

function recordField(record: Record<string, unknown>, camel: string, snake?: string) {
  return asRecord(field(record, camel, snake));
}

function nonNegativeNumberField(record: Record<string, unknown>, camel: string, snake?: string) {
  const value = numberField(record, camel, snake);
  return value !== null && value >= 0 ? value : 0;
}

function normalizePromptPacking(value: unknown): GrantAnalysisPromptPacking | null {
  const record = asRecord(value);

  if (!record) {
    return null;
  }

  const primaryForum = recordField(record, "primaryForum", "primary_forum") ?? {};
  const candidateCount = nonNegativeNumberField(record, "candidateCount", "candidate_count");
  const selectedCount = nonNegativeNumberField(record, "selectedCount", "selected_count");
  const renderedChars = nonNegativeNumberField(record, "renderedChars", "rendered_chars");
  const configVersion = stringField(record, "configVersion", "config_version");

  if (!candidateCount && !selectedCount && !renderedChars && !configVersion) {
    return null;
  }

  const explicitBudget =
    numberField(record, "promptBudgetChars", "prompt_budget_chars") ??
    numberField(record, "maxPromptChars", "max_prompt_chars") ??
    numberField(record, "budgetChars", "budget_chars");

  return {
    configVersion,
    candidateCount,
    selectedCount,
    renderedChars,
    promptBudgetChars: explicitBudget && explicitBudget > 0
      ? explicitBudget
      : defaultCommitteeBriefingPromptBudgetChars,
    truncatedCount: nonNegativeNumberField(record, "truncatedCount", "truncated_count"),
    currentApplicationRenderedRatio: Math.max(
      0,
      numberField(record, "currentApplicationRenderedRatio", "current_application_rendered_ratio") ?? 0
    ),
    currentApplicationTargetMet: booleanField(
      record,
      "currentApplicationTargetMet",
      "current_application_target_met"
    ),
    primaryForum: {
      linked: booleanField(primaryForum, "linked") ?? false,
      candidateRecords: nonNegativeNumberField(primaryForum, "candidateRecords", "candidate_records"),
      selectedRecords: nonNegativeNumberField(primaryForum, "selectedRecords", "selected_records"),
      availablePostCount: nonNegativeNumberField(primaryForum, "availablePostCount", "available_post_count"),
      packedPostCount: nonNegativeNumberField(primaryForum, "packedPostCount", "packed_post_count"),
      omittedPostCount: nonNegativeNumberField(primaryForum, "omittedPostCount", "omitted_post_count")
    }
  };
}

function normalizeFreshnessDetails(value: unknown): GrantAnalysisFreshnessDetails | null {
  const record = asRecord(value);

  if (!record) {
    return null;
  }

  return {
    status: oneOf(field(record, "status"), ["fresh", "stale", "unknown"] as const, "unknown"),
    evidenceStatus: oneOf(
      field(record, "evidenceStatus", "evidence_status"),
      ["current", "changed", "unknown"] as const,
      "unknown"
    ),
    evidenceRecordCount: nonNegativeNumberField(
      record,
      "evidenceRecordCount",
      "evidence_record_count"
    ),
    changedEvidenceRecordCount: nonNegativeNumberField(
      record,
      "changedEvidenceRecordCount",
      "changed_evidence_record_count"
    ),
    templateChanged: booleanField(record, "templateChanged", "template_changed") ?? false,
    modelChanged: booleanField(record, "modelChanged", "model_changed") ?? false
  };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function safeExternalUrl(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function normalizeEvidence(value: unknown, fallbackPrefix: string): GrantAnalysisEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item, index) => {
    const record = asRecord(item);

    if (!record) {
      return [];
    }

    const citationNumber = numberField(record, "citationNumber", "citation_number") ?? index + 1;
    const knowledgeDocumentId = stringField(record, "knowledgeDocumentId", "knowledge_document_id");
    const sourceId = stringField(record, "sourceId", "source_id");
    const id = stringField(record, "id") ?? knowledgeDocumentId ?? `${fallbackPrefix}-${citationNumber}`;
    const rawChangeStatus = field(record, "changeStatus", "change_status");
    const changeStatus: GrantAnalysisEvidence["changeStatus"] =
      rawChangeStatus === "current" ||
      rawChangeStatus === "changed" ||
      rawChangeStatus === "missing"
        ? rawChangeStatus
        : null;

    return [{
      id,
      citationNumber,
      title:
        stringField(record, "title") ??
        stringField(record, "documentTitle", "document_title") ??
        sourceId ??
        `Evidence ${citationNumber}`,
      excerpt:
        stringField(record, "excerpt") ??
        stringField(record, "contentSnapshot", "content_snapshot") ??
        stringField(record, "content"),
      sourceKind: stringField(record, "sourceKind", "source_kind"),
      sourceId,
      sourceUrl: safeExternalUrl(stringField(record, "sourceUrl", "source_url")),
      applicationId: stringField(record, "applicationId", "application_id"),
      knowledgeDocumentId,
      evidenceRole: stringField(record, "evidenceRole", "evidence_role"),
      contentHash: stringField(record, "contentHash", "content_hash"),
      changeStatus
    }];
  }).sort((left, right) => left.citationNumber - right.citationNumber);
}

function normalizeReport(value: unknown): GrantAnalysisReport | null {
  const record = asRecord(value);

  if (!record) {
    return null;
  }

  const id = stringField(record, "id");
  const applicationId = stringField(record, "applicationId", "application_id");

  if (!id || !applicationId) {
    return null;
  }

  const reportType = oneOf(
    field(record, "reportType", "report_type"),
    ["committee_briefing", "custom"] as const,
    "custom"
  );
  const evidence = normalizeEvidence(field(record, "evidence") ?? field(record, "citations"), id);
  const generationMetadata = recordField(record, "generationMetadata", "generation_metadata") ?? {};
  const promptPacking = normalizePromptPacking(
    field(generationMetadata, "promptPacking", "prompt_packing")
  );
  const freshnessDetails = normalizeFreshnessDetails(
    field(record, "freshnessDetails", "freshness_details")
  );

  return {
    id,
    applicationId,
    reportType,
    visibility: oneOf(
      field(record, "visibility"),
      ["temporary", "private", "shared"] as const,
      "private"
    ),
    status: oneOf(
      field(record, "status"),
      ["queued", "running", "succeeded", "failed"] as const,
      "succeeded"
    ),
    title:
      stringField(record, "title") ??
      (reportType === "committee_briefing" ? "Committee briefing" : "Custom analysis"),
    customPrompt: stringField(record, "customPrompt", "custom_prompt"),
    answerText: stringField(record, "answerText", "answer_text"),
    answerStatus: stringField(record, "answerStatus", "answer_status"),
    errorMessage: stringField(record, "errorMessage", "error_message"),
    evidenceFingerprint: stringField(record, "evidenceFingerprint", "evidence_fingerprint"),
    currentEvidenceFingerprint: stringField(
      record,
      "currentEvidenceFingerprint",
      "current_evidence_fingerprint"
    ),
    isStale: booleanField(record, "isStale", "is_stale"),
    freshnessStatus: oneOf(
      field(record, "freshnessStatus", "freshness_status"),
      ["fresh", "stale", "unknown"] as const,
      "unknown"
    ),
    freshnessDetails,
    templateKey: stringField(record, "templateKey", "template_key"),
    templateVersion:
      stringField(record, "templateVersion", "template_version") ??
      numberField(record, "templateVersion", "template_version"),
    provider: stringField(record, "provider"),
    model: stringField(record, "model"),
    retrievalMode: oneOf(
      field(record, "retrievalMode", "retrieval_mode"),
      ["keyword", "semantic", "hybrid"] as const,
      "hybrid"
    ),
    version:
      numberField(record, "version") ??
      numberField(record, "versionNumber", "version_number"),
    requestedByDisplayName: stringField(
      record,
      "requestedByDisplayName",
      "requested_by_display_name"
    ),
    requestedByEmail:
      stringField(record, "requestedByEmail", "requested_by_email") ??
      stringField(record, "authorEmail", "author_email"),
    supersedesReportId: stringField(record, "supersedesReportId", "supersedes_report_id"),
    createdAt:
      stringField(record, "createdAt", "created_at") ??
      stringField(record, "updatedAt", "updated_at") ??
      new Date(0).toISOString(),
    updatedAt: stringField(record, "updatedAt", "updated_at"),
    completedAt: stringField(record, "completedAt", "completed_at"),
    evidence,
    generationMetadata,
    promptPacking
  };
}

function normalizeReports(value: unknown): GrantAnalysisReport[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const report = normalizeReport(item);
    return report ? [report] : [];
  });
}

async function responseJson(response: Response) {
  const text = await response.text();

  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      response.ok
        ? "The server returned an invalid response."
        : `The server returned a non-JSON error response (${response.status}).`
    );
  }
}

function responseError(body: unknown, fallback: string) {
  const record = asRecord(body);
  const error = record?.error;

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  const errorRecord = asRecord(error);
  return typeof errorRecord?.message === "string" && errorRecord.message.trim()
    ? errorRecord.message
    : fallback;
}

function reportTimestamp(report: GrantAnalysisReport) {
  return Date.parse(report.completedAt ?? report.updatedAt ?? report.createdAt) || 0;
}

function sortReports(reports: readonly GrantAnalysisReport[]) {
  return [...reports].sort((left, right) => {
    if ((right.version ?? 0) !== (left.version ?? 0)) {
      return (right.version ?? 0) - (left.version ?? 0);
    }

    return reportTimestamp(right) - reportTimestamp(left);
  });
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "Not completed";
  }

  const parsed = new Date(value);

  if (!Number.isFinite(parsed.getTime())) {
    return "Date unavailable";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(parsed) + " UTC";
}

function humanize(value: string | null | undefined) {
  if (!value) {
    return "Unknown";
  }

  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function shortFingerprint(value: string | null | undefined) {
  return value ? value.slice(0, 12) : "Unavailable";
}

function formatCount(value: number) {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatPercent(value: number) {
  return `${Math.round(Math.max(0, value) * 100)}%`;
}

function freshness(report: GrantAnalysisReport): "fresh" | "stale" | "unknown" {
  if (report.isStale === true || report.freshnessStatus === "stale") {
    return "stale";
  }

  if (report.isStale === false || report.freshnessStatus === "fresh") {
    return "fresh";
  }

  if (report.evidenceFingerprint && report.currentEvidenceFingerprint) {
    return report.evidenceFingerprint === report.currentEvidenceFingerprint ? "fresh" : "stale";
  }

  return "unknown";
}

function freshnessLabel(report: GrantAnalysisReport) {
  const details = report.freshnessDetails;

  if (details?.status === "unknown") {
    return "Freshness unknown";
  }

  if (details?.evidenceStatus === "changed") {
    return "Evidence changed";
  }

  if (details?.templateChanged || details?.modelChanged) {
    return "Briefing update available";
  }

  if (details?.evidenceStatus === "current" || freshness(report) === "fresh") {
    return "Evidence current";
  }

  if (freshness(report) === "stale") {
    return "Evidence changed";
  }

  return "Freshness unknown";
}

function staleNotice(report: GrantAnalysisReport) {
  if (freshness(report) !== "stale") {
    return null;
  }

  const details = report.freshnessDetails;

  if (!details) {
    return "Evidence used by this briefing or its generation settings have changed. Regeneration will preserve this version in history.";
  }

  const changes: string[] = [];

  if (details.evidenceStatus === "changed") {
    const recordWord = details.evidenceRecordCount === 1 ? "record" : "records";
    const verb = details.changedEvidenceRecordCount === 1 ? "has" : "have";
    const availabilityVerb = details.changedEvidenceRecordCount === 1 ? "is" : "are";
    changes.push(
      `${formatCount(details.changedEvidenceRecordCount)} of ${formatCount(details.evidenceRecordCount)} evidence ${recordWord} used by this briefing ${verb} changed or ${availabilityVerb} no longer available`
    );
  }

  if (details.templateChanged || details.modelChanged) {
    changes.push("the briefing template or model has changed");
  }

  return `${changes.join("; ")}. Regeneration will preserve this version in history.`;
}

function clampPollMs(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 750), 5000) : defaultPollMs;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function evidenceFromSearchResult(value: unknown, fallbackPrefix: string) {
  const result = asRecord(value);
  const items = result?.results;
  return normalizeEvidence(items, fallbackPrefix);
}

function BriefingMarkdown({
  answerText,
  evidence,
  reportId,
  compact = false
}: {
  answerText: string;
  evidence: readonly GrantAnalysisEvidence[];
  reportId: string;
  compact?: boolean;
}) {
  const anchorPrefix = `grant-analysis-evidence-${reportId}`;
  const linkedMarkdown = linkEvidenceCitationsInMarkdown(answerText, evidence, anchorPrefix);

  return (
    <div
      className={`${styles.answer} ${compact ? styles.compactAnswer : ""}`}
      id={`grant-analysis-answer-${reportId}`}
    >
      <ReactMarkdown
        components={{
          a: ({ children, href }) => href?.startsWith(`#${anchorPrefix}-`) ? (
            <a
              aria-label={`Jump to ${children} in the evidence snapshot`}
              className={styles.inlineCitation}
              href={href}
            >
              {children}
            </a>
          ) : <span className={styles.unlinkedGeneratedLink}>{children}</span>,
          h1: ({ children }) => <h4>{children}</h4>,
          h2: ({ children }) => <h4>{children}</h4>,
          h3: ({ children }) => <h5>{children}</h5>,
          h4: ({ children }) => <h5>{children}</h5>,
          h5: ({ children }) => <h5>{children}</h5>,
          h6: ({ children }) => <h5>{children}</h5>,
          img: () => null,
          table: ({ children }) => (
            <div className={styles.tableScroller}>
              <table>{children}</table>
            </div>
          )
        }}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {linkedMarkdown}
      </ReactMarkdown>
    </div>
  );
}

function EvidenceList({
  evidence,
  reportId
}: {
  evidence: readonly GrantAnalysisEvidence[];
  reportId: string;
}) {
  if (!evidence.length) {
    return <p className={styles.muted}>No citation snapshot is available for this report.</p>;
  }

  const anchorPrefix = `grant-analysis-evidence-${reportId}`;

  return (
    <ol className={styles.evidenceList}>
      {evidence.map((item) => {
        const changeClass = item.changeStatus === "changed"
          ? styles.evidenceItemChanged
          : item.changeStatus === "missing"
            ? styles.evidenceItemMissing
            : "";

        return (
          <li
            className={`${styles.evidenceItem} ${changeClass}`}
            id={`${anchorPrefix}-${item.citationNumber}`}
            key={`${item.id}-${item.citationNumber}`}
          >
            <div className={styles.evidenceHeading}>
              <span className={styles.citationNumber}>[{item.citationNumber}]</span>
              <strong>{item.title}</strong>
            </div>
            <div className={styles.chipRow}>
              {item.changeStatus === "changed" ? (
                <span
                  className={`${styles.chip} ${styles.evidenceChangedChip}`}
                  title="The indexed source has changed since this briefing was generated."
                >
                  Changed since briefing
                </span>
              ) : null}
              {item.changeStatus === "missing" ? (
                <span
                  className={`${styles.chip} ${styles.evidenceMissingChip}`}
                  title="A matching current evidence record could not be identified."
                >
                  No current match
                </span>
              ) : null}
              {item.evidenceRole ? (
                <span
                  className={styles.chip}
                  title={
                    item.evidenceRole === "current"
                      ? "This evidence is about the application being reviewed."
                      : undefined
                  }
                >
                  {item.evidenceRole === "current"
                    ? "This application"
                    : humanize(item.evidenceRole)}
                </span>
              ) : null}
              {item.sourceKind ? (
                <span className={styles.chip}>{humanize(item.sourceKind)}</span>
              ) : null}
            </div>
            {item.excerpt ? <p>{item.excerpt}</p> : null}
            <div className={styles.evidenceLinks}>
              {item.sourceUrl ? (
                <a href={item.sourceUrl} rel="noreferrer" target="_blank">
                  Open original source <span aria-hidden="true">↗</span>
                </a>
              ) : null}
              {item.applicationId ? (
                <a href={`/admin/grants/${encodeURIComponent(item.applicationId)}`} target="_blank">
                  Open application <span aria-hidden="true">↗</span>
                </a>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function EvidenceDisclosureSummary({ evidence }: { evidence: readonly GrantAnalysisEvidence[] }) {
  const changedCount = evidence.filter(
    (item) => item.changeStatus === "changed" || item.changeStatus === "missing"
  ).length;

  return (
    <summary>
      Evidence and citations <span>({evidence.length})</span>
      {changedCount ? (
        <span className={styles.evidenceChangeSummary}> · {changedCount} changed or unavailable</span>
      ) : null}
    </summary>
  );
}

function ReportMetadata({ report }: { report: GrantAnalysisReport }) {
  const reportFreshness = freshness(report);
  const author = report.requestedByDisplayName ?? report.requestedByEmail ?? "Unknown author";

  return (
    <dl className={styles.metadata}>
      <div>
        <dt>Evidence</dt>
        <dd>
          <span className={`${styles.freshnessBadge} ${styles[reportFreshness]}`}>
            {freshnessLabel(report)}
          </span>
        </dd>
      </div>
      <div>
        <dt>Version</dt>
        <dd>{report.version ?? "—"}</dd>
      </div>
      <div>
        <dt>Generated</dt>
        <dd>{formatDate(report.completedAt ?? report.createdAt)}</dd>
      </div>
      <div>
        <dt>Author</dt>
        <dd>{author}</dd>
      </div>
      <div>
        <dt>Visibility</dt>
        <dd>{humanize(report.visibility)}</dd>
      </div>
      <div>
        <dt>Template</dt>
        <dd>{report.templateVersion ? `${report.templateKey ?? "Committee briefing"} v${report.templateVersion}` : "Custom prompt"}</dd>
      </div>
      <div>
        <dt>Model</dt>
        <dd>{[report.provider, report.model].filter(Boolean).join(" / ") || "Unavailable"}</dd>
      </div>
      <div>
        <dt>Evidence snapshot</dt>
        <dd title={report.evidenceFingerprint ?? undefined}>{shortFingerprint(report.evidenceFingerprint)}</dd>
      </div>
    </dl>
  );
}

function EvidenceCoverage({ report }: { report: GrantAnalysisReport }) {
  const packing = report.promptPacking;

  if (report.reportType !== "committee_briefing" || !packing) {
    return null;
  }

  const promptUsageRatio = packing.promptBudgetChars
    ? packing.renderedChars / packing.promptBudgetChars
    : 0;
  const omittedRecords = Math.max(0, packing.candidateCount - packing.selectedCount);
  const omittedForumChunks = Math.max(
    0,
    packing.primaryForum.candidateRecords - packing.primaryForum.selectedRecords
  );

  return (
    <details className={styles.coverageDisclosure}>
      <summary>
        Evidence coverage
        <span>{formatCount(packing.selectedCount)} of {formatCount(packing.candidateCount)} records selected</span>
      </summary>
      <div className={styles.coverageBody}>
        <p className={styles.coverageIntro}>
          Generation diagnostics show what was available to the briefing process and what was supplied to the model.
        </p>
        <dl className={styles.coverageGrid}>
          <div>
            <dt>Evidence records</dt>
            <dd>{formatCount(packing.selectedCount)} selected</dd>
            <small>{formatCount(omittedRecords)} omitted from {formatCount(packing.candidateCount)} candidates</small>
          </div>
          <div>
            <dt>Current application share</dt>
            <dd>{formatPercent(packing.currentApplicationRenderedRatio)}</dd>
            <small>
              {packing.currentApplicationTargetMet === false
                ? "Below the briefing coverage target"
                : "Of the evidence prompt"}
            </small>
          </div>
          <div>
            <dt>Prompt use</dt>
            <dd>{formatCount(packing.renderedChars)} characters</dd>
            <small>
              {formatPercent(promptUsageRatio)} of {formatCount(packing.promptBudgetChars)}
            </small>
          </div>
          <div>
            <dt>Truncated records</dt>
            <dd>{formatCount(packing.truncatedCount)}</dd>
            <small>Selected records shortened to fit the prompt</small>
          </div>
        </dl>

        {packing.primaryForum.linked ? (
          <section aria-label="Primary Forum coverage" className={styles.forumCoverage}>
            <h5>Primary Forum discussion</h5>
            <dl>
              <div>
                <dt>Posts</dt>
                <dd>
                  <strong>{formatCount(packing.primaryForum.packedPostCount)} packed</strong>
                  <span>{formatCount(packing.primaryForum.omittedPostCount)} omitted</span>
                  <span>{formatCount(packing.primaryForum.availablePostCount)} available</span>
                </dd>
              </div>
              <div>
                <dt>Discussion chunks</dt>
                <dd>
                  <strong>{formatCount(packing.primaryForum.selectedRecords)} packed</strong>
                  <span>{formatCount(omittedForumChunks)} omitted</span>
                  <span>{formatCount(packing.primaryForum.candidateRecords)} available</span>
                </dd>
              </div>
            </dl>
            {packing.primaryForum.omittedPostCount > 0 || omittedForumChunks > 0 ? (
              <p>
                Omitted discussion remains indexed but was not included in this version&apos;s model prompt.
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
    </details>
  );
}

function ReportBody({ report, compact = false }: { report: GrantAnalysisReport; compact?: boolean }) {
  const evidence = report.evidence ?? [];

  if (report.status === "failed") {
    return <p className={styles.errorBox}>{report.errorMessage ?? "This analysis did not complete."}</p>;
  }

  if (report.status === "queued" || report.status === "running") {
    return <p className={styles.progressBox}>This analysis is {report.status}. You can leave this page while it completes.</p>;
  }

  return (
    <>
      {report.customPrompt ? (
        <details className={styles.promptDisclosure}>
          <summary>Prompt used</summary>
          <p>{report.customPrompt}</p>
        </details>
      ) : null}
      {report.answerText ? (
        <BriefingMarkdown
          answerText={report.answerText}
          compact={compact}
          evidence={evidence}
          reportId={report.id}
        />
      ) : <p className={styles.muted}>The report completed without answer text.</p>}
      <EvidenceCoverage report={report} />
      <details className={styles.evidenceDisclosure}>
        <EvidenceDisclosureSummary evidence={evidence} />
        <EvidenceList evidence={evidence} reportId={report.id} />
      </details>
    </>
  );
}

export function CommitteeBriefingDocument({ report }: { report: GrantAnalysisReport }) {
  const normalizedReport = normalizeReport(report);

  if (!normalizedReport) {
    return <p className={styles.errorBox}>This committee briefing could not be displayed.</p>;
  }

  const reportFreshness = freshness(normalizedReport);
  const reportFreshnessNotice = staleNotice(normalizedReport);

  return (
    <article className={`${styles.latestReport} ${styles.briefingDocument}`}>
      <div className={styles.reportHeading}>
        <div>
          <div className={styles.chipRow}>
            <span className={`${styles.freshnessBadge} ${styles[reportFreshness]}`}>
              {freshnessLabel(normalizedReport)}
            </span>
            <span className={styles.chip}>{humanize(normalizedReport.visibility)}</span>
          </div>
          <h2 className={styles.briefingDocumentTitle}>{normalizedReport.title}</h2>
        </div>
      </div>
      {reportFreshnessNotice ? (
        <p className={styles.staleNotice}>{reportFreshnessNotice}</p>
      ) : null}
      <ReportMetadata report={normalizedReport} />
      <ReportBody report={normalizedReport} />
    </article>
  );
}

function SavedReportCard({ report }: { report: GrantAnalysisReport }) {
  return (
    <article className={styles.savedReport}>
      <div className={styles.savedReportHeading}>
        <div>
          <h4>{report.title}</h4>
          <p>{formatDate(report.completedAt ?? report.createdAt)}</p>
        </div>
        <div className={styles.chipRow}>
          <span className={styles.chip}>{humanize(report.visibility)}</span>
          <span className={styles.chip}>{humanize(report.status)}</span>
        </div>
      </div>
      <ReportBody compact report={report} />
    </article>
  );
}

export function GrantAnalysisPanel({
  applicationId,
  initialReports,
  canRead,
  canGenerate,
  committeeBriefingEligible,
  canPublish
}: GrantAnalysisPanelProps) {
  const customPromptId = useId();
  const customTitleId = useId();
  const retrievalId = useId();
  const visibilityLegendId = useId();
  const [reports, setReports] = useState<GrantAnalysisReport[]>(() => normalizeReports(initialReports));
  const [activeOperation, setActiveOperation] = useState<ActiveOperation>(null);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [temporaryAnalysis, setTemporaryAnalysis] = useState<TemporaryAnalysis | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [visibility, setVisibility] = useState<GrantAnalysisVisibility>("private");
  const [retrievalMode, setRetrievalMode] = useState<GrantAnalysisRetrievalMode>("hybrid");
  const [reportActionFeedback, setReportActionFeedback] = useState<ReportActionFeedback>(null);
  const panelRef = useRef<HTMLDetailsElement>(null);
  const printCleanupRef = useRef<(() => void) | null>(null);
  const runTokenRef = useRef(0);

  useEffect(() => () => {
    runTokenRef.current += 1;
    printCleanupRef.current?.();
    delete document.body.dataset.grantBriefingPrint;
  }, []);

  const orderedReports = useMemo(() => sortReports(reports), [reports]);
  const committeeReports = useMemo(
    () => orderedReports.filter((report) => report.reportType === "committee_briefing"),
    [orderedReports]
  );
  const successfulBriefings = committeeReports.filter(
    (report) => report.status === "succeeded" && Boolean(report.answerText)
  );
  const latestBriefing =
    successfulBriefings.find((report) => report.visibility === "shared") ?? successfulBriefings[0] ?? null;
  const latestBriefingId = latestBriefing?.id ?? null;
  const pendingBriefing = committeeReports.find(
    (report) => report.status === "queued" || report.status === "running"
  );
  const briefingHistory = latestBriefing
    ? committeeReports.filter((report) => report.id !== latestBriefing.id)
    : committeeReports;
  const customReports = orderedReports.filter((report) => report.reportType === "custom");

  useEffect(() => {
    if (!latestBriefingId) {
      return;
    }

    const targetId = `committee-briefing-${latestBriefingId}`;
    const revealLinkedBriefing = () => {
      if (window.location.hash !== `#${targetId}`) {
        return;
      }

      if (panelRef.current) {
        panelRef.current.open = true;
      }

      window.requestAnimationFrame(() => {
        document.getElementById(targetId)?.scrollIntoView({ block: "start" });
      });
    };

    revealLinkedBriefing();
    window.addEventListener("hashchange", revealLinkedBriefing);
    return () => window.removeEventListener("hashchange", revealLinkedBriefing);
  }, [latestBriefingId]);

  function mergeReport(report: GrantAnalysisReport) {
    setReports((current) => sortReports([report, ...current.filter((item) => item.id !== report.id)]));
  }

  async function copyBriefing(report: GrantAnalysisReport) {
    setReportActionFeedback(null);
    const answer = document.getElementById(`grant-analysis-answer-${report.id}`);

    if (!answer) {
      setReportActionFeedback({ kind: "error", message: "The rendered briefing is not available to copy." });
      return;
    }

    const plainText = [report.title, answer.innerText.trim()].filter(Boolean).join("\n\n");

    try {
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        const presentation = document.createElement("article");
        const title = document.createElement("h1");
        title.textContent = report.title;
        presentation.append(title, answer.cloneNode(true));

        try {
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/html": new Blob([presentation.innerHTML], { type: "text/html" }),
              "text/plain": new Blob([plainText], { type: "text/plain" })
            })
          ]);
        } catch {
          if (!navigator.clipboard.writeText) {
            throw new Error("Formatted clipboard access was denied.");
          }

          await navigator.clipboard.writeText(plainText);
        }
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(plainText);
      } else {
        fallbackCopyText(plainText);
      }

      setReportActionFeedback({ kind: "success", message: "Committee briefing copied to the clipboard." });
    } catch {
      try {
        fallbackCopyText(plainText);
        setReportActionFeedback({ kind: "success", message: "Committee briefing copied to the clipboard." });
      } catch {
        setReportActionFeedback({
          kind: "error",
          message: "The browser blocked clipboard access. Select the briefing text and copy it manually."
        });
      }
    }
  }

  function printBriefing(report: GrantAnalysisReport) {
    printCleanupRef.current?.();
    const panel = panelRef.current;

    if (!panel) {
      setReportActionFeedback({ kind: "error", message: "The briefing could not be prepared for printing." });
      return;
    }

    setReportActionFeedback(null);
    const wasOpen = panel.open;
    const previousTitle = document.title;
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      delete document.body.dataset.grantBriefingPrint;
      document.title = previousTitle;
      panel.open = wasOpen;
      window.removeEventListener("afterprint", cleanup);
      printCleanupRef.current = null;

      window.clearTimeout(fallbackTimer);
    };

    panel.open = true;
    document.body.dataset.grantBriefingPrint = "true";
    document.title = `${report.title} — Committee briefing`;
    window.addEventListener("afterprint", cleanup);
    const fallbackTimer = window.setTimeout(cleanup, 60_000);
    printCleanupRef.current = cleanup;

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        try {
          window.print();
        } catch {
          cleanup();
          setReportActionFeedback({ kind: "error", message: "The browser could not open the print dialog." });
        }
      });
    });
  }

  async function refreshReports(silent = false) {
    if (!silent) {
      setActiveOperation("refresh");
      setError(null);
      setOperationMessage("Refreshing saved analyses.");
    }

    try {
      const response = await fetch(`/api/admin/grants/${encodeURIComponent(applicationId)}/analysis`, {
        method: "GET",
        cache: "no-store"
      });
      const body = await responseJson(response);

      if (!response.ok) {
        throw new Error(responseError(body, "Could not refresh saved analyses."));
      }

      const bodyRecord = asRecord(body);

      if (!Array.isArray(bodyRecord?.reports)) {
        throw new Error("The saved analysis response did not include a report list.");
      }

      setReports(normalizeReports(bodyRecord.reports));

      if (!silent) {
        setOperationMessage("Saved analyses are up to date.");
      }
    } catch (refreshError) {
      if (silent) {
        throw refreshError;
      }

      if (!silent) {
        setError(refreshError instanceof Error ? refreshError.message : "Could not refresh saved analyses.");
        setOperationMessage(null);
      }
    } finally {
      if (!silent) {
        setActiveOperation(null);
      }
    }
  }

  async function pollJob({
    jobId,
    runToken,
    prompt,
    title,
    requestedVisibility
  }: {
    jobId: string;
    runToken: number;
    prompt: string;
    title: string;
    requestedVisibility: GrantAnalysisVisibility;
  }) {
    let pollDelay = defaultPollMs;

    while (runTokenRef.current === runToken) {
      await sleep(pollDelay);

      if (runTokenRef.current !== runToken) {
        return;
      }

      const response = await fetch(`/api/admin/knowledge/search/jobs/${encodeURIComponent(jobId)}`, {
        method: "GET",
        cache: "no-store"
      });
      const body = await responseJson(response);

      if (!response.ok) {
        throw new Error(responseError(body, "Analysis job status could not be loaded."));
      }

      const bodyRecord = asRecord(body);
      const status = oneOf(
        bodyRecord?.status,
        ["queued", "running", "succeeded", "failed", "expired"] as const,
        "failed"
      ) as JobStatus;

      if (status === "queued" || status === "running") {
        setOperationMessage(`Grounded analysis is ${status}. You may leave this page while it completes.`);
        pollDelay = clampPollMs(bodyRecord?.pollAfterMs);
        continue;
      }

      if (status === "failed" || status === "expired") {
        throw new Error(responseError(body, status === "expired" ? "Analysis job expired." : "Analysis job failed."));
      }

      const returnedReport = normalizeReport(bodyRecord?.report ?? asRecord(bodyRecord?.result)?.report);

      if (returnedReport) {
        mergeReport(returnedReport);
      }

      if (requestedVisibility === "temporary") {
        const resultRecord = asRecord(bodyRecord?.result);
        const answerText = typeof resultRecord?.answerText === "string" ? resultRecord.answerText : null;

        if (!answerText) {
          throw new Error("The temporary analysis completed without answer text.");
        }

        setTemporaryAnalysis({
          id: jobId,
          title: title || "Temporary grounded analysis",
          prompt,
          answerText,
          evidence: evidenceFromSearchResult(resultRecord, jobId),
          createdAt: new Date().toISOString()
        });
      } else {
        await refreshReports(true);
      }

      setOperationMessage("Grounded analysis completed.");
      return;
    }
  }

  async function generateAnalysis({
    reportType,
    prompt,
    title,
    requestedVisibility,
    requestedRetrievalMode
  }: {
    reportType: GrantAnalysisReportType;
    prompt?: string;
    title?: string;
    requestedVisibility: GrantAnalysisVisibility;
    requestedRetrievalMode: GrantAnalysisRetrievalMode;
  }) {
    const operation: Exclude<ActiveOperation, "refresh" | null> =
      reportType === "committee_briefing" ? "briefing" : "custom";
    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    setActiveOperation(operation);
    setError(null);
    setOperationMessage("Preparing the evidence pack and starting grounded analysis.");

    try {
      const response = await fetch(`/api/admin/grants/${encodeURIComponent(applicationId)}/analysis`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "generate",
          reportType,
          ...(prompt ? { prompt } : {}),
          ...(title ? { title } : {}),
          visibility: requestedVisibility,
          retrievalMode: requestedRetrievalMode
        })
      });
      const body = await responseJson(response);

      if (!response.ok) {
        throw new Error(responseError(body, "Grounded analysis could not be started."));
      }

      const bodyRecord = asRecord(body);
      const report = normalizeReport(bodyRecord?.report);

      if (report) {
        mergeReport(report);
      }

      const jobId = typeof bodyRecord?.jobId === "string" ? bodyRecord.jobId : null;

      if (jobId) {
        await pollJob({
          jobId,
          runToken,
          prompt: prompt ?? "Standard committee briefing",
          title: title ?? "Committee briefing",
          requestedVisibility
        });
      } else if (report?.status === "succeeded") {
        if (requestedVisibility === "temporary" && report.answerText) {
          setTemporaryAnalysis({
            id: report.id,
            title: title ?? report.title,
            prompt: prompt ?? "Custom grounded analysis",
            answerText: report.answerText,
            evidence: report.evidence ?? [],
            createdAt: report.completedAt ?? report.createdAt
          });
        }

        setOperationMessage("Grounded analysis completed.");
      } else if (requestedVisibility === "temporary") {
        throw new Error("The temporary analysis response did not include a job or result.");
      } else {
        await refreshReports(true);
        setOperationMessage("Grounded analysis was requested. Refresh later to see the result.");
      }
    } catch (generationError) {
      if (runTokenRef.current === runToken) {
        setError(generationError instanceof Error ? generationError.message : "Grounded analysis failed.");
        setOperationMessage(null);
      }
    } finally {
      if (runTokenRef.current === runToken) {
        setActiveOperation(null);
      }
    }
  }

  async function submitCustomAnalysis(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = customPrompt.trim();

    if (!prompt) {
      setError("Enter a question or analysis prompt.");
      return;
    }

    await generateAnalysis({
      reportType: "custom",
      prompt,
      title: customTitle.trim() || undefined,
      requestedVisibility: visibility,
      requestedRetrievalMode: retrievalMode
    });
  }

  if (!canRead) {
    return (
      <details aria-labelledby="grant-analysis-heading" className={styles.panel}>
        <summary className={styles.panelSummary}>
          <span className={styles.summaryText}>
            <span className={styles.eyebrow}>AI-grounded decision support</span>
            <span aria-level={2} className={styles.panelTitle} id="grant-analysis-heading" role="heading">
              Committee briefing
            </span>
          </span>
          <span className={styles.summaryStatus}>Restricted</span>
        </summary>
        <div className={styles.panelBody}>
          <p className={styles.muted}>Your account does not have access to saved grant analyses.</p>
        </div>
      </details>
    );
  }

  const busy = activeOperation !== null;
  const briefingBusy = busy || Boolean(pendingBriefing);
  const canGenerateBriefing = canGenerate && committeeBriefingEligible;
  const latestFreshness = latestBriefing ? freshness(latestBriefing) : null;

  return (
    <details
      aria-labelledby="grant-analysis-heading"
      className={styles.panel}
      data-grant-analysis-panel
      ref={panelRef}
    >
      <summary className={styles.panelSummary}>
        <span className={styles.summaryText}>
          <span className={styles.eyebrow}>AI-grounded decision support</span>
          <span aria-level={2} className={styles.panelTitle} id="grant-analysis-heading" role="heading">
            Committee briefing
          </span>
          <span className={styles.summaryDescription}>
            Review an evidence-grounded briefing or ask a custom question about this application. AI output supports
            committee review; it does not recommend or make a funding decision.
          </span>
        </span>
        <span className={styles.summaryStatus}>
          {pendingBriefing
            ? "In progress"
            : latestBriefing
              ? `Version ${latestBriefing.version ?? "—"} · ${freshnessLabel(latestBriefing)}`
              : "Not generated"}
        </span>
      </summary>

      <div className={styles.panelBody}>
        <div className={styles.sectionActions}>
          <button
            className={styles.secondaryButton}
            disabled={busy}
            onClick={() => void refreshReports()}
            type="button"
          >
            {activeOperation === "refresh" ? "Refreshing…" : "Refresh reports"}
          </button>
        </div>

      {pendingBriefing ? (
        <p className={styles.progressBox} role="status">
          Committee briefing version {pendingBriefing.version ?? "new"} is {pendingBriefing.status}. You may leave
          this page while generation continues.
        </p>
      ) : null}

      {canGenerate && !committeeBriefingEligible ? (
        <p className={styles.muted}>
          Committee briefings become available after FPF assigns the proposal with both the Grant Application and
          Ready For ZCG Review GitHub labels.
        </p>
      ) : null}

      {latestBriefing ? (
        <article className={styles.latestReport} id={`committee-briefing-${latestBriefing.id}`}>
          <div className={styles.reportHeading}>
            <div>
              <div className={styles.chipRow}>
                <span className={`${styles.freshnessBadge} ${styles[latestFreshness ?? "unknown"]}`}>
                  {freshnessLabel(latestBriefing)}
                </span>
                <span className={styles.chip}>{humanize(latestBriefing.visibility)}</span>
              </div>
              <h3>{latestBriefing.title}</h3>
            </div>
            <div className={styles.reportActions}>
              <button
                aria-label={`Copy ${latestBriefing.title}`}
                className={styles.secondaryButton}
                onClick={() => void copyBriefing(latestBriefing)}
                type="button"
              >
                Copy briefing
              </button>
              <button
                aria-label={`Print ${latestBriefing.title}`}
                className={styles.secondaryButton}
                onClick={() => printBriefing(latestBriefing)}
                type="button"
              >
                Print briefing
              </button>
              {canGenerateBriefing ? (
                <button
                  className={styles.primaryButton}
                  disabled={briefingBusy}
                  onClick={() => void generateAnalysis({
                    reportType: "committee_briefing",
                    requestedVisibility: "shared",
                    requestedRetrievalMode: "hybrid"
                  })}
                  type="button"
                >
                  {pendingBriefing
                    ? "Briefing in progress…"
                    : activeOperation === "briefing"
                      ? "Regenerating…"
                      : "Regenerate with current evidence"}
                </button>
              ) : null}
            </div>
          </div>
          {reportActionFeedback ? (
            <p
              aria-live="polite"
              className={`${styles.actionFeedback} ${reportActionFeedback.kind === "error" ? styles.actionFeedbackError : ""}`}
              role={reportActionFeedback.kind === "error" ? "alert" : "status"}
            >
              {reportActionFeedback.message}
            </p>
          ) : null}
          {latestFreshness === "stale" ? (
            <p className={styles.staleNotice}>
              {staleNotice(latestBriefing)}
            </p>
          ) : null}
          <ReportMetadata report={latestBriefing} />
          <ReportBody report={latestBriefing} />
        </article>
      ) : (
        <div className={styles.emptyState}>
          <div>
            <h3>No committee briefing yet</h3>
            <p>
              Generate a standard briefing from this application, linked evidence, team history, relationships, and
              comparable grants. The completed shared report will be available to other authorized users.
            </p>
          </div>
          {canGenerateBriefing ? (
            <button
              className={styles.primaryButton}
              disabled={briefingBusy}
              onClick={() => void generateAnalysis({
                reportType: "committee_briefing",
                requestedVisibility: "shared",
                requestedRetrievalMode: "hybrid"
              })}
              type="button"
            >
              {pendingBriefing
                ? "Briefing in progress…"
                : activeOperation === "briefing"
                  ? "Generating…"
                  : "Generate committee briefing"}
            </button>
          ) : canGenerate ? (
            <p className={styles.muted}>This proposal has not yet received both official FPF assignment labels.</p>
          ) : (
            <p className={styles.muted}>Your account can read shared briefings but cannot generate them.</p>
          )}
        </div>
      )}

      {briefingHistory.length ? (
        <details className={styles.historyDisclosure}>
          <summary>
            Version history <span>({briefingHistory.length})</span>
          </summary>
          <div className={styles.savedReportList}>
            {briefingHistory.map((report) => <SavedReportCard key={report.id} report={report} />)}
          </div>
        </details>
      ) : null}

      <div className={styles.divider} />

      <div className={styles.customSection}>
        <div>
          <p className={styles.eyebrow}>Application-scoped research</p>
          <h3>Ask about this application</h3>
          <p className={styles.intro}>
            Ask a focused question. Answers use the grant knowledge index and retain numbered links to the evidence
            supplied to the model.
          </p>
        </div>

        {canGenerate ? (
          <form className={styles.customForm} onSubmit={submitCustomAnalysis}>
            <label className={styles.field} htmlFor={customPromptId}>
              <span>Question or analysis prompt</span>
              <textarea
                id={customPromptId}
                maxLength={8000}
                onChange={(event) => setCustomPrompt(event.target.value)}
                placeholder="Which delivery risks and unanswered technical questions should the committee discuss?"
                required
                rows={5}
                value={customPrompt}
              />
            </label>

            <div className={styles.formGrid}>
              <label className={styles.field} htmlFor={customTitleId}>
                <span>Saved title (optional)</span>
                <input
                  id={customTitleId}
                  maxLength={160}
                  onChange={(event) => setCustomTitle(event.target.value)}
                  placeholder="Technical risk review"
                  type="text"
                  value={customTitle}
                />
              </label>
              <label className={styles.field} htmlFor={retrievalId}>
                <span>Retrieval</span>
                <select
                  id={retrievalId}
                  onChange={(event) => setRetrievalMode(event.target.value as GrantAnalysisRetrievalMode)}
                  value={retrievalMode}
                >
                  <option value="hybrid">Hybrid</option>
                  <option value="semantic">Semantic</option>
                  <option value="keyword">Keyword</option>
                </select>
              </label>
            </div>

            <fieldset aria-describedby={visibilityLegendId} className={styles.visibilityFieldset}>
              <legend>Keep this answer</legend>
              <p id={visibilityLegendId}>
                Temporary answers are not attached to the grant. Private answers are visible to you and
                administrators. Shared answers are visible to authorized users.
              </p>
              <div className={styles.radioGrid}>
                <label>
                  <input
                    checked={visibility === "temporary"}
                    name="analysis-visibility"
                    onChange={() => setVisibility("temporary")}
                    type="radio"
                  />
                  <span>
                    <strong>Temporary</strong>
                    <small>View in this session</small>
                  </span>
                </label>
                <label>
                  <input
                    checked={visibility === "private"}
                    name="analysis-visibility"
                    onChange={() => setVisibility("private")}
                    type="radio"
                  />
                  <span>
                    <strong>Private</strong>
                    <small>Save for me</small>
                  </span>
                </label>
                <label className={!canPublish ? styles.disabledChoice : undefined}>
                  <input
                    checked={visibility === "shared"}
                    disabled={!canPublish}
                    name="analysis-visibility"
                    onChange={() => setVisibility("shared")}
                    type="radio"
                  />
                  <span>
                    <strong>Shared</strong>
                    <small>{canPublish ? "Save for authorized users" : "Publish access required"}</small>
                  </span>
                </label>
              </div>
            </fieldset>

            <div className={styles.formActions}>
              <button className={styles.primaryButton} disabled={busy || !customPrompt.trim()} type="submit">
                {activeOperation === "custom" ? "Generating grounded answer…" : "Generate grounded answer"}
              </button>
              <span>Factual claims should be checked against the cited source snapshot.</span>
            </div>
          </form>
        ) : (
          <p className={styles.muted}>Your account can read shared analyses but cannot generate a custom answer.</p>
        )}
      </div>

      {operationMessage ? <p className={styles.progressBox} role="status">{operationMessage}</p> : null}
      {error ? <p className={styles.errorBox} role="alert">{error}</p> : null}

      {temporaryAnalysis ? (
        <article className={styles.temporaryReport}>
          <div className={styles.reportHeading}>
            <div>
              <span className={styles.chip}>Temporary</span>
              <h3>{temporaryAnalysis.title}</h3>
              <p className={styles.muted}>{formatDate(temporaryAnalysis.createdAt)}</p>
            </div>
            <button className={styles.secondaryButton} onClick={() => setTemporaryAnalysis(null)} type="button">
              Clear temporary answer
            </button>
          </div>
          <details className={styles.promptDisclosure}>
            <summary>Prompt used</summary>
            <p>{temporaryAnalysis.prompt}</p>
          </details>
          <BriefingMarkdown
            answerText={temporaryAnalysis.answerText}
            evidence={temporaryAnalysis.evidence}
            reportId={temporaryAnalysis.id}
          />
          <details className={styles.evidenceDisclosure}>
            <EvidenceDisclosureSummary evidence={temporaryAnalysis.evidence} />
            <EvidenceList evidence={temporaryAnalysis.evidence} reportId={temporaryAnalysis.id} />
          </details>
        </article>
      ) : null}

      {customReports.length ? (
        <details className={styles.historyDisclosure}>
          <summary>
            Saved custom analyses <span>({customReports.length})</span>
          </summary>
          <div className={styles.savedReportList}>
            {customReports.map((report) => <SavedReportCard key={report.id} report={report} />)}
          </div>
        </details>
      ) : null}
      </div>
    </details>
  );
}
