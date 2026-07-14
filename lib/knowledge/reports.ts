import { createHash } from "node:crypto";
import { query } from "@/lib/db";

export type GrantAnalysisReportType = "committee_briefing" | "custom";
export type GrantAnalysisReportVisibility = "private" | "shared";
export type GrantAnalysisReportStatus = "queued" | "running" | "succeeded" | "failed";
export type GrantAnalysisReportFreshness = "fresh" | "stale" | "unknown";
export type GrantAnalysisReportEvidenceFreshness = "current" | "changed" | "unknown";
export type GrantAnalysisReportEvidenceChangeStatus = "current" | "changed" | "missing";
export type GrantAnalysisReportFreshnessDetails = {
  status: GrantAnalysisReportFreshness;
  evidenceStatus: GrantAnalysisReportEvidenceFreshness;
  evidenceRecordCount: number;
  changedEvidenceRecordCount: number;
  templateChanged: boolean;
  modelChanged: boolean;
};
export type GrantAnalysisReportFreshnessInput = {
  report: Pick<
    GrantAnalysisReport,
    | "id"
    | "status"
    | "evidenceFingerprint"
    | "completedAt"
    | "templateKey"
    | "templateVersion"
    | "model"
  >;
  currentTemplateKey: string;
  currentTemplateVersion: string;
  currentModel: string;
};
type GrantAnalysisReportFreshnessDependencies = {
  query: <T extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ) => Promise<{ rows: T[] }>;
};
export type GrantAnalysisReportAnswerStatus =
  | "evidence"
  | "generated"
  | "fallback"
  | "disabled"
  | "not_requested";
export type GrantAnalysisEvidenceRole =
  | "current"
  | "team_history"
  | "related"
  | "similar_approved"
  | "similar_declined"
  | "external";

export type GrantAnalysisReportAccess = {
  principalId: string | null;
  canReadAllPrivateReports?: boolean;
};

export type GrantAnalysisReport = {
  id: string;
  applicationId: string;
  reportType: GrantAnalysisReportType;
  visibility: GrantAnalysisReportVisibility;
  title: string;
  customPrompt: string | null;
  templateKey: string;
  templateVersion: string;
  versionNumber: number;
  status: GrantAnalysisReportStatus;
  requestedByPrincipalId: string | null;
  requestedByEmail: string | null;
  requestedByDisplayName: string | null;
  answerJobId: string | null;
  answerText: string | null;
  answerStatus: GrantAnalysisReportAnswerStatus | null;
  errorMessage: string | null;
  evidenceFingerprint: string | null;
  provider: string | null;
  model: string | null;
  generationMetadata: Record<string, unknown>;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  supersedesReportId: string | null;
  regenerationReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export type GrantAnalysisReportEvidence = {
  reportId: string;
  citationNumber: number;
  knowledgeDocumentId: string | null;
  documentKey: string;
  contentHash: string;
  evidenceRole: GrantAnalysisEvidenceRole;
  retrievalRank: number | null;
  applicationId: string;
  sourceRecordId: string | null;
  title: string | null;
  sourceKind: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  contentSnapshot: string | null;
  metadata: Record<string, unknown>;
  changeStatus: GrantAnalysisReportEvidenceChangeStatus;
  createdAt: string;
};

export type GrantAnalysisReportEvidenceInput = Omit<
  GrantAnalysisReportEvidence,
  "reportId" | "changeStatus" | "createdAt"
>;

export type GrantAnalysisEvidenceFingerprintInput = {
  documents: ReadonlyArray<{
    knowledgeDocumentId: string | null;
    contentHash: string;
    evidenceRole: GrantAnalysisEvidenceRole;
    applicationId?: string;
    citationNumber?: number;
  }>;
  relationships?: readonly unknown[];
  participants?: readonly unknown[];
  template: {
    key: string;
    version: string;
  };
  retrievalConfiguration?: unknown;
  modelConfiguration?: unknown;
};

type GrantAnalysisReportRow = {
  id: string;
  application_id: string;
  report_type: GrantAnalysisReportType;
  visibility: GrantAnalysisReportVisibility;
  title: string;
  custom_prompt: string | null;
  template_key: string;
  template_version: string;
  version_number: number | string;
  status: GrantAnalysisReportStatus;
  requested_by_principal_id: string | null;
  requested_by_email?: string | null;
  requested_by_display_name?: string | null;
  answer_job_id: string | null;
  answer_text: string | null;
  answer_status: GrantAnalysisReportAnswerStatus | null;
  error_message: string | null;
  evidence_fingerprint: string | null;
  provider: string | null;
  model: string | null;
  generation_metadata: string | Record<string, unknown> | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  latency_ms: number | string | null;
  supersedes_report_id: string | null;
  regeneration_reason: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

type GrantAnalysisReportEvidenceRow = {
  report_id: string;
  citation_number: number | string;
  knowledge_document_id: string | null;
  document_key: string;
  content_hash: string;
  evidence_role: GrantAnalysisEvidenceRole;
  retrieval_rank: number | string | null;
  application_id: string;
  source_record_id: string | null;
  title: string | null;
  source_kind: string | null;
  source_id: string | null;
  source_url: string | null;
  content_snapshot: string | null;
  metadata: string | Record<string, unknown> | null;
  current_content_hash: string | null;
  created_at: string;
};

const reportReturningColumns = `id::text,
  application_id::text,
  report_type,
  visibility,
  title,
  custom_prompt,
  template_key,
  template_version,
  version_number,
  status,
  requested_by_principal_id::text,
  null::text as requested_by_email,
  null::text as requested_by_display_name,
  answer_job_id::text,
  answer_text,
  answer_status,
  error_message,
  evidence_fingerprint,
  provider,
  model,
  generation_metadata::text,
  input_tokens,
  output_tokens,
  latency_ms,
  supersedes_report_id::text,
  regeneration_reason,
  created_at::text,
  started_at::text,
  completed_at::text,
  updated_at::text`;

function reportSelectColumns(alias: string) {
  return `${alias}.id::text,
    ${alias}.application_id::text,
    ${alias}.report_type,
    ${alias}.visibility,
    ${alias}.title,
    ${alias}.custom_prompt,
    ${alias}.template_key,
    ${alias}.template_version,
    ${alias}.version_number,
    ${alias}.status,
    ${alias}.requested_by_principal_id::text,
    requester.email as requested_by_email,
    requester.display_name as requested_by_display_name,
    ${alias}.answer_job_id::text,
    ${alias}.answer_text,
    ${alias}.answer_status,
    ${alias}.error_message,
    ${alias}.evidence_fingerprint,
    ${alias}.provider,
    ${alias}.model,
    ${alias}.generation_metadata::text,
    ${alias}.input_tokens,
    ${alias}.output_tokens,
    ${alias}.latency_ms,
    ${alias}.supersedes_report_id::text,
    ${alias}.regeneration_reason,
    ${alias}.created_at::text,
    ${alias}.started_at::text,
    ${alias}.completed_at::text,
    ${alias}.updated_at::text`;
}

function parseJsonRecord(value: string | Record<string, unknown> | null) {
  if (!value) {
    return {};
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function nullableNumber(value: number | string | null) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapReportRow(row: GrantAnalysisReportRow): GrantAnalysisReport {
  return {
    id: row.id,
    applicationId: row.application_id,
    reportType: row.report_type,
    visibility: row.visibility,
    title: row.title,
    customPrompt: row.custom_prompt,
    templateKey: row.template_key,
    templateVersion: row.template_version,
    versionNumber: Number(row.version_number),
    status: row.status,
    requestedByPrincipalId: row.requested_by_principal_id,
    requestedByEmail: row.requested_by_email ?? null,
    requestedByDisplayName: row.requested_by_display_name ?? null,
    answerJobId: row.answer_job_id,
    answerText: row.answer_text,
    answerStatus: row.answer_status,
    errorMessage: row.error_message,
    evidenceFingerprint: row.evidence_fingerprint,
    provider: row.provider,
    model: row.model,
    generationMetadata: parseJsonRecord(row.generation_metadata),
    inputTokens: nullableNumber(row.input_tokens),
    outputTokens: nullableNumber(row.output_tokens),
    latencyMs: nullableNumber(row.latency_ms),
    supersedesReportId: row.supersedes_report_id,
    regenerationReason: row.regeneration_reason,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  };
}

function mapEvidenceRow(row: GrantAnalysisReportEvidenceRow): GrantAnalysisReportEvidence {
  return {
    reportId: row.report_id,
    citationNumber: Number(row.citation_number),
    knowledgeDocumentId: row.knowledge_document_id,
    documentKey: row.document_key,
    contentHash: row.content_hash,
    evidenceRole: row.evidence_role,
    retrievalRank: nullableNumber(row.retrieval_rank),
    applicationId: row.application_id,
    sourceRecordId: row.source_record_id,
    title: row.title,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    contentSnapshot: row.content_snapshot,
    metadata: parseJsonRecord(row.metadata),
    changeStatus: grantAnalysisEvidenceChangeStatus(row.content_hash, row.current_content_hash),
    createdAt: row.created_at
  };
}

export function grantAnalysisEvidenceChangeStatus(
  savedContentHash: string,
  currentContentHash: string | null
): GrantAnalysisReportEvidenceChangeStatus {
  if (currentContentHash === null) {
    return "missing";
  }

  return savedContentHash === currentContentHash ? "current" : "changed";
}

function canonicalFingerprintValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(canonicalFingerprintValue);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalFingerprintValue(entry)])
    );
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }

  return value;
}

export function stableFingerprintValue(value: unknown) {
  return JSON.stringify(canonicalFingerprintValue(value)) ?? "null";
}

export function buildGrantAnalysisEvidenceFingerprint(input: GrantAnalysisEvidenceFingerprintInput) {
  const payload = {
    documents: input.documents.map((document) => ({
      knowledgeDocumentId: document.knowledgeDocumentId,
      contentHash: document.contentHash,
      evidenceRole: document.evidenceRole,
      applicationId: document.applicationId ?? null,
      citationNumber: document.citationNumber ?? null
    })),
    relationships: input.relationships ?? [],
    participants: input.participants ?? [],
    template: input.template,
    retrievalConfiguration: input.retrievalConfiguration ?? null,
    modelConfiguration: input.modelConfiguration ?? null
  };

  return createHash("sha256").update(stableFingerprintValue(payload)).digest("hex");
}

export function isGrantAnalysisReportFresh(
  saved: Pick<GrantAnalysisReport, "evidenceFingerprint"> | string | null,
  currentFingerprint: string | null
) {
  const savedFingerprint = typeof saved === "string" ? saved : saved?.evidenceFingerprint ?? null;
  return Boolean(savedFingerprint && currentFingerprint && savedFingerprint === currentFingerprint);
}

export function compareGrantAnalysisReportEvidence(
  savedEvidence: ReadonlyArray<{ documentKey: string; contentHash: string }>,
  currentEvidence: ReadonlyArray<{ documentKey: string; contentHash: string }>
) {
  const currentByDocumentKey = new Map(
    currentEvidence.map((document) => [document.documentKey, document.contentHash])
  );
  const changedEvidenceRecordCount = savedEvidence.filter(
    (document) =>
      grantAnalysisEvidenceChangeStatus(
        document.contentHash,
        currentByDocumentKey.get(document.documentKey) ?? null
      ) !== "current"
  ).length;

  return {
    evidenceRecordCount: savedEvidence.length,
    changedEvidenceRecordCount
  };
}

export function isPublishedCommitteeBriefing(
  report:
    | Pick<GrantAnalysisReport, "reportType" | "visibility" | "status" | "answerText">
    | null
    | undefined
) {
  return Boolean(
    report &&
      report.reportType === "committee_briefing" &&
      report.visibility === "shared" &&
      report.status === "succeeded" &&
      report.answerText?.trim()
  );
}

export async function getGrantAnalysisReportFreshnessDetails(
  {
    report,
    currentTemplateKey,
    currentTemplateVersion,
    currentModel
  }: GrantAnalysisReportFreshnessInput,
  dependencies: GrantAnalysisReportFreshnessDependencies = {
    query: query as GrantAnalysisReportFreshnessDependencies["query"]
  }
): Promise<GrantAnalysisReportFreshnessDetails> {
  const templateChanged =
    report.templateKey !== currentTemplateKey || report.templateVersion !== currentTemplateVersion;
  const modelChanged = report.model !== currentModel;

  if (report.status !== "succeeded" || !report.evidenceFingerprint || !report.completedAt) {
    return {
      status: "unknown",
      evidenceStatus: "unknown",
      evidenceRecordCount: 0,
      changedEvidenceRecordCount: 0,
      templateChanged,
      modelChanged
    };
  }

  const result = await dependencies.query<{
    saved_document_key: string;
    saved_content_hash: string;
    current_document_key: string | null;
    current_content_hash: string | null;
  }>(
    `select saved.document_key as saved_document_key,
            saved.content_hash as saved_content_hash,
            current_document.document_key as current_document_key,
            current_document.content_hash as current_content_hash
       from grant_analysis_report_evidence saved
       left join grant_knowledge_documents current_document
         on current_document.document_key = saved.document_key
      where saved.report_id = $1
      order by saved.citation_number`,
    [report.id]
  );

  const comparison = compareGrantAnalysisReportEvidence(
    result.rows.map((row) => ({
      documentKey: row.saved_document_key,
      contentHash: row.saved_content_hash
    })),
    result.rows.flatMap((row) =>
      row.current_document_key && row.current_content_hash
        ? [{ documentKey: row.current_document_key, contentHash: row.current_content_hash }]
        : []
    )
  );
  const hasEvidenceSnapshot = comparison.evidenceRecordCount > 0;
  const evidenceChanged = comparison.changedEvidenceRecordCount > 0;

  return {
    status: !hasEvidenceSnapshot
      ? "unknown"
      : evidenceChanged || templateChanged || modelChanged
        ? "stale"
        : "fresh",
    evidenceStatus: !hasEvidenceSnapshot ? "unknown" : evidenceChanged ? "changed" : "current",
    ...comparison,
    templateChanged,
    modelChanged
  };
}

export async function getGrantAnalysisReportFreshness(
  input: GrantAnalysisReportFreshnessInput
): Promise<GrantAnalysisReportFreshness> {
  return (await getGrantAnalysisReportFreshnessDetails(input)).status;
}

export async function createGrantAnalysisReport({
  applicationId,
  reportType,
  visibility,
  title,
  requestedByPrincipalId,
  customPrompt = null,
  templateKey,
  templateVersion,
  evidenceFingerprint = null,
  supersedesReportId = null,
  regenerationReason = null,
  generationMetadata = {}
}: {
  applicationId: string;
  reportType: GrantAnalysisReportType;
  visibility: GrantAnalysisReportVisibility;
  title: string;
  requestedByPrincipalId: string;
  customPrompt?: string | null;
  templateKey: string;
  templateVersion: string;
  evidenceFingerprint?: string | null;
  supersedesReportId?: string | null;
  regenerationReason?: string | null;
  generationMetadata?: Record<string, unknown>;
}) {
  if (reportType === "custom" && !customPrompt?.trim()) {
    throw new Error("Custom grant analyses require a prompt.");
  }

  const result = await query<GrantAnalysisReportRow>(
    `with version_lock as materialized (
       select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))
     )
     insert into grant_analysis_reports (
       application_id,
       report_type,
       visibility,
       title,
       custom_prompt,
       template_key,
       template_version,
       version_number,
       status,
       requested_by_principal_id,
       evidence_fingerprint,
       supersedes_report_id,
       regeneration_reason,
       generation_metadata
     )
     select $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            coalesce((
              select max(version_number) + 1
                from grant_analysis_reports
               where application_id = $1
                 and report_type = $2
            ), 1),
            'queued',
            $8,
            $9,
            $10::uuid,
            $11,
            $12::jsonb
       from version_lock
      where $10::uuid is null
         or exists (
              select 1
                from grant_analysis_reports prior
               where prior.id = $10::uuid
                 and prior.application_id = $1
                 and prior.report_type = $2
            )
     returning ${reportReturningColumns}`,
    [
      applicationId,
      reportType,
      visibility,
      title.trim(),
      customPrompt?.trim() || null,
      templateKey,
      templateVersion,
      requestedByPrincipalId,
      evidenceFingerprint,
      supersedesReportId,
      regenerationReason,
      JSON.stringify(generationMetadata)
    ]
  );

  if (!result.rows[0]) {
    throw new Error("The report being superseded does not belong to this application and report type.");
  }

  return mapReportRow(result.rows[0]);
}

export async function attachGrantAnalysisReportJob(reportId: string, answerJobId: string) {
  const result = await query<GrantAnalysisReportRow>(
    `update grant_analysis_reports
        set answer_job_id = $2,
            updated_at = now()
      where id = $1
        and status = 'queued'
        and (answer_job_id is null or answer_job_id = $2)
      returning ${reportReturningColumns}`,
    [reportId, answerJobId]
  );

  return result.rows[0] ? mapReportRow(result.rows[0]) : null;
}

export async function listGrantAnalysisReports({
  applicationId,
  access,
  reportType = null,
  includeFailed = true,
  limit = 12
}: {
  applicationId: string;
  access: GrantAnalysisReportAccess;
  reportType?: GrantAnalysisReportType | null;
  includeFailed?: boolean;
  limit?: number;
}) {
  const boundedLimit = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), 30)
    : 12;
  const result = await query<GrantAnalysisReportRow>(
    `select ${reportSelectColumns("gar")}
       from grant_analysis_reports gar
       left join principals requester on requester.id = gar.requested_by_principal_id
      where gar.application_id = $1
        and ($3::boolean = true
             or gar.visibility = 'shared'
             or gar.requested_by_principal_id = $2::uuid)
        and ($4::text is null or gar.report_type = $4)
        and ($5::boolean = true or gar.status <> 'failed')
      order by gar.created_at desc,
               gar.version_number desc
      limit $6`,
    [
      applicationId,
      access.principalId,
      access.canReadAllPrivateReports === true,
      reportType,
      includeFailed,
      boundedLimit
    ]
  );

  return result.rows.map(mapReportRow);
}

export async function getGrantAnalysisReport({
  reportId,
  applicationId = null,
  access
}: {
  reportId: string;
  applicationId?: string | null;
  access: GrantAnalysisReportAccess;
}) {
  const result = await query<GrantAnalysisReportRow>(
    `select ${reportSelectColumns("gar")}
       from grant_analysis_reports gar
       left join principals requester on requester.id = gar.requested_by_principal_id
      where gar.id = $1
        and ($2::uuid is null or gar.application_id = $2::uuid)
        and ($4::boolean = true
             or gar.visibility = 'shared'
             or gar.requested_by_principal_id = $3::uuid)`,
    [reportId, applicationId, access.principalId, access.canReadAllPrivateReports === true]
  );

  return result.rows[0] ? mapReportRow(result.rows[0]) : null;
}

async function getGrantAnalysisReportById(reportId: string) {
  const result = await query<GrantAnalysisReportRow>(
    `select ${reportSelectColumns("gar")}
       from grant_analysis_reports gar
       left join principals requester on requester.id = gar.requested_by_principal_id
      where gar.id = $1`,
    [reportId]
  );

  return result.rows[0] ? mapReportRow(result.rows[0]) : null;
}

export async function claimGrantAnalysisReport(reportId: string) {
  const result = await query<GrantAnalysisReportRow>(
    `update grant_analysis_reports
        set status = 'running',
            started_at = coalesce(started_at, now()),
            error_message = null,
            updated_at = now()
      where id = $1
        and status = 'queued'
      returning ${reportReturningColumns}`,
    [reportId]
  );

  return result.rows[0] ? mapReportRow(result.rows[0]) : null;
}

function validateEvidence(evidence: readonly GrantAnalysisReportEvidenceInput[]) {
  const citations = new Set<number>();

  for (const item of evidence) {
    if (!Number.isInteger(item.citationNumber) || item.citationNumber <= 0) {
      throw new Error("Report evidence citation numbers must be positive integers.");
    }

    if (citations.has(item.citationNumber)) {
      throw new Error(`Duplicate report evidence citation number ${item.citationNumber}.`);
    }

    if (!item.contentHash.trim()) {
      throw new Error(`Report evidence citation ${item.citationNumber} requires a content hash.`);
    }

    citations.add(item.citationNumber);
  }
}

export async function replaceGrantAnalysisReportEvidence(
  reportId: string,
  evidence: readonly GrantAnalysisReportEvidenceInput[]
) {
  validateEvidence(evidence);
  const payload = evidence.map((item) => ({
    ...item,
    documentKey: item.documentKey || item.knowledgeDocumentId || `citation:${item.citationNumber}`,
    metadata: item.metadata ?? {}
  }));

  for (const item of payload) {
    await query(
      `insert into grant_analysis_report_evidence (
         report_id,
         citation_number,
         knowledge_document_id,
         document_key,
         content_hash,
         evidence_role,
         retrieval_rank,
         application_id,
         source_record_id,
         title,
         source_kind,
         source_id,
         source_url,
         content_snapshot,
         metadata
       ) values (
         $1,
         $2,
         $3::uuid,
         $4,
         $5,
         $6,
         $7,
         $8::uuid,
         $9::uuid,
         $10,
         $11,
         $12,
         $13,
         $14,
         $15::jsonb
       )
       on conflict (report_id, citation_number)
       do update set knowledge_document_id = excluded.knowledge_document_id,
                     document_key = excluded.document_key,
                     content_hash = excluded.content_hash,
                     evidence_role = excluded.evidence_role,
                     retrieval_rank = excluded.retrieval_rank,
                     application_id = excluded.application_id,
                     source_record_id = excluded.source_record_id,
                     title = excluded.title,
                     source_kind = excluded.source_kind,
                     source_id = excluded.source_id,
                     source_url = excluded.source_url,
                     content_snapshot = excluded.content_snapshot,
                     metadata = excluded.metadata`,
      [
        reportId,
        item.citationNumber,
        item.knowledgeDocumentId,
        item.documentKey,
        item.contentHash,
        item.evidenceRole,
        item.retrievalRank,
        item.applicationId,
        item.sourceRecordId,
        item.title,
        item.sourceKind,
        item.sourceId,
        item.sourceUrl,
        item.contentSnapshot,
        JSON.stringify(item.metadata)
      ]
    );
  }

  await query(
    `delete from grant_analysis_report_evidence existing
      where existing.report_id = $1
        and not exists (
          select 1
            from jsonb_array_elements_text($2::jsonb) citation(value)
           where citation.value::integer = existing.citation_number
        )`,
    [reportId, JSON.stringify(payload.map((item) => item.citationNumber))]
  );
}

export async function listGrantAnalysisReportEvidence(reportId: string) {
  const result = await query<GrantAnalysisReportEvidenceRow>(
    `select saved.report_id::text,
            saved.citation_number,
            saved.knowledge_document_id::text,
            saved.document_key,
            saved.content_hash,
            saved.evidence_role,
            saved.retrieval_rank,
            saved.application_id::text,
            saved.source_record_id::text,
            saved.title,
            saved.source_kind,
            saved.source_id,
            saved.source_url,
            left(saved.content_snapshot, 600) as content_snapshot,
            saved.metadata::text,
            current_document.content_hash as current_content_hash,
            saved.created_at::text
       from grant_analysis_report_evidence saved
       left join grant_knowledge_documents current_document
         on current_document.document_key = saved.document_key
      where saved.report_id = $1
      order by saved.citation_number`,
    [reportId]
  );

  return result.rows.map(mapEvidenceRow);
}

export async function completeGrantAnalysisReport({
  reportId,
  answerText,
  answerStatus,
  evidenceFingerprint,
  provider = null,
  model = null,
  generationMetadata = {},
  inputTokens = null,
  outputTokens = null,
  latencyMs = null,
  evidence
}: {
  reportId: string;
  answerText: string;
  answerStatus: GrantAnalysisReportAnswerStatus;
  evidenceFingerprint: string;
  provider?: string | null;
  model?: string | null;
  generationMetadata?: Record<string, unknown>;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  evidence?: readonly GrantAnalysisReportEvidenceInput[];
}) {
  const current = await getGrantAnalysisReportById(reportId);

  if (!current || current.status === "succeeded" || current.status === "failed") {
    return current;
  }

  if (evidence) {
    await replaceGrantAnalysisReportEvidence(reportId, evidence);
  }

  const result = await query<GrantAnalysisReportRow>(
    `update grant_analysis_reports
        set status = 'succeeded',
            answer_text = $2,
            answer_status = $3,
            error_message = null,
            evidence_fingerprint = $4,
            provider = $5,
            model = $6,
            generation_metadata = generation_metadata || $7::jsonb,
            input_tokens = $8,
            output_tokens = $9,
            latency_ms = $10,
            started_at = coalesce(started_at, now()),
            completed_at = now(),
            updated_at = now()
      where id = $1
        and status in ('queued', 'running')
      returning ${reportReturningColumns}`,
    [
      reportId,
      answerText,
      answerStatus,
      evidenceFingerprint,
      provider,
      model,
      JSON.stringify(generationMetadata),
      inputTokens,
      outputTokens,
      latencyMs
    ]
  );

  return result.rows[0] ? mapReportRow(result.rows[0]) : getGrantAnalysisReportById(reportId);
}

export async function failGrantAnalysisReport(
  reportId: string,
  message: string,
  generationMetadata: Record<string, unknown> = {}
) {
  const result = await query<GrantAnalysisReportRow>(
    `update grant_analysis_reports
        set status = 'failed',
            error_message = $2,
            generation_metadata = generation_metadata || $3::jsonb,
            completed_at = now(),
            updated_at = now()
      where id = $1
        and status in ('queued', 'running')
      returning ${reportReturningColumns}`,
    [reportId, message, JSON.stringify(generationMetadata)]
  );

  return result.rows[0] ? mapReportRow(result.rows[0]) : getGrantAnalysisReportById(reportId);
}
