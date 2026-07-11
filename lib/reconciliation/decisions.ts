import { createHash } from "node:crypto";
import { recordAuditEvent } from "@/lib/audit";
import { query } from "@/lib/db";

export type ReconciliationDecisionType =
  | "link_source"
  | "unlink_source"
  | "relate_applications"
  | "merge_applications"
  | "override_field"
  | "dismiss_issue";

export type ReconciliationDecisionInput = {
  decisionType: ReconciliationDecisionType;
  sourceKind?: string | null;
  sourceId?: string | null;
  canonicalType?: string | null;
  canonicalKey?: string | null;
  relatedCanonicalKey?: string | null;
  relationshipType?: string | null;
  fieldName?: string | null;
  fieldValue?: unknown;
  rationale?: string | null;
  confidence?: number | null;
  evidence?: Record<string, unknown> | null;
  reconciliationIssueId?: string | null;
  resolutionStatus?: "resolved" | "dismissed" | null;
};

export type ReconciliationWorkspace = {
  summary: ReconciliationWorkspaceSummary;
  openIssues: ReconciliationIssueReviewRow[];
  decisions: ReconciliationDecisionRow[];
  relationships: GrantApplicationRelationshipRow[];
};

export type ReconciliationWorkspaceSummary = {
  openIssueCount: string;
  activeDecisionCount: string;
  relationshipCount: string;
  linkedIssueDecisionCount: string;
};

export type ReconciliationIssueReviewRow = {
  id: string;
  issueType: string;
  severity: "info" | "warning" | "error";
  status: string;
  summary: string;
  details: string;
  sourceKind: string | null;
  sourceId: string | null;
  sourceTitle: string | null;
  canonicalKey: string | null;
  canonicalTitle: string | null;
  githubIssueNumber: string | null;
  normalizedStatus: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReconciliationDecisionRow = {
  id: string;
  decisionKey: string;
  decisionType: ReconciliationDecisionType;
  status: string;
  sourceKind: string | null;
  sourceId: string | null;
  canonicalType: string;
  canonicalKey: string | null;
  relatedCanonicalKey: string | null;
  relationshipType: string | null;
  fieldName: string | null;
  fieldValue: string | null;
  rationale: string;
  confidence: string;
  evidence: string;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
  linkedIssues: string | null;
};

export type GrantApplicationRelationshipRow = {
  relationshipKey: string;
  relationshipType: string;
  rationale: string | null;
  fromCanonicalKey: string;
  fromTitle: string;
  toCanonicalKey: string;
  toTitle: string;
  sourceDecisionKey: string | null;
  updatedAt: string;
};

export type ManualReconciliationApplyResult = {
  linkedSources: number;
  unlinkedSources: number;
  relationships: number;
  directlyResolvedIssues: number;
  inferredDismissedIssues: number;
  inferredResolvedIssues: number;
};

export type ManualSourceDecisionApplyResult = {
  linkedSources: number;
  unlinkedSources: number;
};

type IssueContextRow = {
  id: string;
  issue_type: string;
  summary: string;
  details: string;
  source_kind: string | null;
  source_id: string | null;
  canonical_key: string | null;
};

type DecisionExportRow = {
  decision_key: string;
  decision_type: ReconciliationDecisionType;
  status: string;
  source_kind: string | null;
  source_id: string | null;
  canonical_type: string;
  canonical_key: string | null;
  related_canonical_key: string | null;
  relationship_type: string | null;
  field_name: string | null;
  field_value: unknown;
  rationale: string;
  confidence: string;
  evidence: unknown;
  created_at: string;
  updated_at: string;
};

export class ReconciliationDecisionError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ReconciliationDecisionError";
    this.status = status;
  }
}

const decisionTypes = new Set<ReconciliationDecisionType>([
  "link_source",
  "unlink_source",
  "relate_applications",
  "merge_applications",
  "override_field",
  "dismiss_issue"
]);

export function manualSourceLinkKey(params: {
  sourceKind: string;
  sourceId: string;
  canonicalType?: string | null;
  canonicalKey: string;
}) {
  return `${params.sourceKind}:${params.sourceId}->${params.canonicalType ?? "grant_application"}:${params.canonicalKey}`;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonValue(value: unknown) {
  if (typeof value !== "string") {
    return value ?? null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeDecisionType(value: unknown): ReconciliationDecisionType {
  const decisionType = stringValue(value);

  if (!decisionType || !decisionTypes.has(decisionType as ReconciliationDecisionType)) {
    throw new ReconciliationDecisionError("Select a supported reconciliation decision type.");
  }

  return decisionType as ReconciliationDecisionType;
}

function normalizeConfidence(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return 1;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new ReconciliationDecisionError("Confidence must be between 0 and 1.");
  }

  return parsed;
}

function decisionKey(input: {
  decisionType: ReconciliationDecisionType;
  sourceKind: string | null;
  sourceId: string | null;
  canonicalType: string;
  canonicalKey: string | null;
  relatedCanonicalKey: string | null;
  relationshipType: string | null;
  fieldName: string | null;
  fieldValue: unknown;
  reconciliationIssueId: string | null;
}) {
  const stablePayload = JSON.stringify({
    decisionType: input.decisionType,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    canonicalType: input.canonicalType,
    canonicalKey: input.canonicalKey,
    relatedCanonicalKey: input.relatedCanonicalKey,
    relationshipType: input.relationshipType,
    fieldName: input.fieldName,
    fieldValue: input.fieldValue ?? null,
    reconciliationIssueId: input.decisionType === "dismiss_issue" ? input.reconciliationIssueId : null
  });
  const digest = createHash("sha256").update(stablePayload).digest("hex").slice(0, 24);
  return `manual:${input.decisionType}:${digest}`;
}

async function issueContext(reconciliationIssueId: string | null) {
  if (!reconciliationIssueId) {
    return null;
  }

  const result = await query<IssueContextRow>(
    `select ri.id::text,
            ri.issue_type,
            ri.summary,
            ri.details::text,
            sr.source_kind,
            sr.source_id,
            ga.canonical_key
       from reconciliation_issues ri
       left join source_records sr on sr.id = ri.source_record_id
       left join grant_applications ga on ga.id = ri.canonical_id
      where ri.id = $1`,
    [reconciliationIssueId]
  );

  const row = result.rows[0];

  if (!row) {
    throw new ReconciliationDecisionError("Reconciliation issue not found.", 404);
  }

  return row;
}

function validateDecision(input: {
  decisionType: ReconciliationDecisionType;
  sourceKind: string | null;
  sourceId: string | null;
  canonicalKey: string | null;
  relatedCanonicalKey: string | null;
  relationshipType: string | null;
  fieldName: string | null;
  fieldValue: unknown;
  rationale: string | null;
  reconciliationIssueId: string | null;
}) {
  if (!input.rationale || input.rationale.length < 8) {
    throw new ReconciliationDecisionError("Add a rationale that explains the manual reconciliation decision.");
  }

  if (input.decisionType === "link_source" || input.decisionType === "unlink_source") {
    if (!input.sourceKind || !input.sourceId || !input.canonicalKey) {
      throw new ReconciliationDecisionError("Source kind, source ID, and canonical key are required for source link decisions.");
    }
  }

  if (input.decisionType === "relate_applications" || input.decisionType === "merge_applications") {
    if (!input.canonicalKey || !input.relatedCanonicalKey || !input.relationshipType) {
      throw new ReconciliationDecisionError("Canonical key, related canonical key, and relationship type are required for application relationship decisions.");
    }

    if (input.canonicalKey === input.relatedCanonicalKey) {
      throw new ReconciliationDecisionError("Related applications must be different records.");
    }
  }

  if (input.decisionType === "override_field" && (!input.canonicalKey || !input.fieldName || input.fieldValue === undefined)) {
    throw new ReconciliationDecisionError("Canonical key, field name, and field value are required for field override decisions.");
  }

  if (input.decisionType === "dismiss_issue" && !input.reconciliationIssueId) {
    throw new ReconciliationDecisionError("A reconciliation issue is required for dismissal decisions.");
  }
}

async function fetchDecisionByKey(key: string) {
  const result = await query<DecisionExportRow>(
    `select decision_key,
            decision_type,
            status,
            source_kind,
            source_id,
            canonical_type,
            canonical_key,
            related_canonical_key,
            relationship_type,
            field_name,
            field_value,
            rationale,
            confidence::text,
            evidence,
            created_at::text,
            updated_at::text
       from reconciliation_decisions
      where decision_key = $1`,
    [key]
  );

  return result.rows[0] ?? null;
}

export async function createReconciliationDecision(input: ReconciliationDecisionInput, actorPrincipalId: string) {
  const decisionType = normalizeDecisionType(input.decisionType);
  const linkedIssueId = optionalString(input.reconciliationIssueId);
  const linkedIssue = await issueContext(linkedIssueId);
  const sourceKind = optionalString(input.sourceKind) ?? linkedIssue?.source_kind ?? null;
  const sourceId = optionalString(input.sourceId) ?? linkedIssue?.source_id ?? null;
  const canonicalType = optionalString(input.canonicalType) ?? "grant_application";
  const canonicalKey = optionalString(input.canonicalKey) ?? linkedIssue?.canonical_key ?? null;
  const relatedCanonicalKey = optionalString(input.relatedCanonicalKey);
  const relationshipType = optionalString(input.relationshipType);
  const fieldName = optionalString(input.fieldName);
  const rationale = stringValue(input.rationale);
  const confidence = normalizeConfidence(input.confidence);
  const resolutionStatus = input.resolutionStatus === "dismissed" ? "dismissed" : "resolved";
  const evidence = {
    ...(input.evidence ?? {}),
    ...(linkedIssue
      ? {
          linkedIssue: {
            id: linkedIssue.id,
            issueType: linkedIssue.issue_type,
            summary: linkedIssue.summary,
            details: JSON.parse(linkedIssue.details || "{}")
          }
        }
      : {})
  };

  validateDecision({
    decisionType,
    sourceKind,
    sourceId,
    canonicalKey,
    relatedCanonicalKey,
    relationshipType,
    fieldName,
    fieldValue: input.fieldValue,
    rationale,
    reconciliationIssueId: linkedIssueId
  });

  const key = decisionKey({
    decisionType,
    sourceKind,
    sourceId,
    canonicalType,
    canonicalKey,
    relatedCanonicalKey,
    relationshipType,
    fieldName,
    fieldValue: input.fieldValue,
    reconciliationIssueId: linkedIssueId
  });
  const before = await fetchDecisionByKey(key);

  const result = await query<{ id: string }>(
    `insert into reconciliation_decisions (
       decision_key,
       decision_type,
       status,
       source_kind,
       source_id,
       canonical_type,
       canonical_key,
       related_canonical_key,
       relationship_type,
       field_name,
       field_value,
       rationale,
       confidence,
       evidence,
       created_by_principal_id,
       updated_at
     )
     values ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14, now())
     on conflict (decision_key)
     do update set status = 'active',
                   source_kind = excluded.source_kind,
                   source_id = excluded.source_id,
                   canonical_type = excluded.canonical_type,
                   canonical_key = excluded.canonical_key,
                   related_canonical_key = excluded.related_canonical_key,
                   relationship_type = excluded.relationship_type,
                   field_name = excluded.field_name,
                   field_value = excluded.field_value,
                   rationale = excluded.rationale,
                   confidence = excluded.confidence,
                   evidence = excluded.evidence,
                   updated_at = now()
     returning id::text`,
    [
      key,
      decisionType,
      sourceKind,
      sourceId,
      canonicalType,
      canonicalKey,
      relatedCanonicalKey,
      relationshipType,
      fieldName,
      input.fieldValue === undefined ? null : JSON.stringify(input.fieldValue),
      rationale,
      confidence,
      JSON.stringify(evidence),
      actorPrincipalId
    ]
  );
  const decisionId = result.rows[0]?.id;

  if (!decisionId) {
    throw new ReconciliationDecisionError("Failed to save reconciliation decision.", 500);
  }

  if (linkedIssueId) {
    await query(
      `insert into reconciliation_decision_issues (decision_id, reconciliation_issue_id, resolution_status)
       values ($1, $2, $3)
       on conflict (decision_id, reconciliation_issue_id)
       do update set resolution_status = excluded.resolution_status`,
      [decisionId, linkedIssueId, resolutionStatus]
    );

    await query(
      `update reconciliation_issues
          set status = $1,
              resolved_by_principal_id = $2,
              resolved_at = coalesce(resolved_at, now()),
              updated_at = now()
        where id = $3
          and status in ('open', 'assigned')`,
      [resolutionStatus, actorPrincipalId, linkedIssueId]
    );
  }

  const applyResult = await applyManualReconciliationDecisions();
  const after = await fetchDecisionByKey(key);

  await recordAuditEvent({
    actorPrincipalId,
    action: before ? "reconciliation.decision.updated" : "reconciliation.decision.created",
    targetType: "reconciliation_decision",
    targetId: key,
    before: before ? { decision: before } : null,
    after: after ? { decision: after } : null,
    metadata: { applyResult }
  });

  return { decisionId, decisionKey: key, applyResult };
}

export async function getActiveManualSourceLinkKeys() {
  const result = await query<{
    source_kind: string;
    source_id: string;
    canonical_type: string;
    canonical_key: string;
  }>(
    `select source_kind,
            source_id,
            canonical_type,
            canonical_key
       from reconciliation_decisions
      where status = 'active'
        and decision_type = 'link_source'
        and source_kind is not null
        and source_id is not null
        and canonical_key is not null`
  );

  return new Set(
    result.rows.map((row) =>
      manualSourceLinkKey({
        sourceKind: row.source_kind,
        sourceId: row.source_id,
        canonicalType: row.canonical_type,
        canonicalKey: row.canonical_key
      })
    )
  );
}

async function countFromQuery(sql: string, values: readonly unknown[] = []) {
  const result = await query<{ affected_count: string }>(sql, values);
  return Number(result.rows[0]?.affected_count ?? 0);
}

export async function applyManualSourceLinkDecisions(): Promise<ManualSourceDecisionApplyResult> {
  const linkedSources = await countFromQuery(
    `with active_decisions as (
       select d.id,
              d.source_kind,
              d.source_id,
              d.canonical_type,
              d.canonical_key,
              d.confidence
         from reconciliation_decisions d
        where d.status = 'active'
          and d.decision_type = 'link_source'
     ),
     resolved_targets as (
       select ad.id,
              sr.id as source_record_id,
              ga.id as canonical_id,
              ad.confidence
         from active_decisions ad
         join source_records sr on sr.source_kind = ad.source_kind
                               and sr.source_id = ad.source_id
         join grant_applications ga on ga.canonical_key = ad.canonical_key
        where ad.canonical_type = 'grant_application'
     ),
     inserted as (
       insert into source_links (source_record_id, canonical_type, canonical_id, confidence)
       select source_record_id, 'grant_application', canonical_id, confidence
         from resolved_targets
       on conflict (source_record_id, canonical_type, canonical_id)
       do update set confidence = excluded.confidence
       returning 1
     )
     select count(*)::text as affected_count from inserted`
  );

  const unlinkedSources = await countFromQuery(
    `with active_decisions as (
       select d.source_kind,
              d.source_id,
              d.canonical_type,
              d.canonical_key
         from reconciliation_decisions d
        where d.status = 'active'
          and d.decision_type = 'unlink_source'
     ),
     deleted as (
       delete from source_links sl
       using active_decisions ad,
             source_records sr,
             grant_applications ga
       where sr.source_kind = ad.source_kind
         and sr.source_id = ad.source_id
         and ga.canonical_key = ad.canonical_key
         and ad.canonical_type = 'grant_application'
         and sl.source_record_id = sr.id
         and sl.canonical_type = 'grant_application'
         and sl.canonical_id = ga.id
       returning 1
     )
     select count(*)::text as affected_count from deleted`
  );

  return { linkedSources, unlinkedSources };
}

export async function applyManualReconciliationDecisions(): Promise<ManualReconciliationApplyResult> {
  const { linkedSources, unlinkedSources } = await applyManualSourceLinkDecisions();

  const relationships = await countFromQuery(
    `with active_decisions as (
       select d.id,
              d.decision_key,
              d.decision_type,
              d.canonical_key,
              d.related_canonical_key,
              d.relationship_type,
              d.rationale
         from reconciliation_decisions d
        where d.status = 'active'
          and d.decision_type in ('relate_applications', 'merge_applications')
     ),
     resolved_targets as (
       select ad.id,
              ad.decision_key,
              from_ga.id as from_application_id,
              to_ga.id as to_application_id,
              case
                when ad.decision_type = 'merge_applications' then 'same_grant'
                else ad.relationship_type
              end as relationship_type,
              ad.rationale
         from active_decisions ad
         join grant_applications from_ga on from_ga.canonical_key = ad.canonical_key
         join grant_applications to_ga on to_ga.canonical_key = ad.related_canonical_key
        where from_ga.id <> to_ga.id
     ),
     inserted as (
       insert into grant_application_relationships (
         relationship_key,
         from_application_id,
         to_application_id,
         relationship_type,
         source_decision_id,
         rationale,
         updated_at
       )
       select decision_key,
              from_application_id,
              to_application_id,
              relationship_type,
              id,
              rationale,
              now()
         from resolved_targets
       on conflict (relationship_key)
       do update set from_application_id = excluded.from_application_id,
                     to_application_id = excluded.to_application_id,
                     relationship_type = excluded.relationship_type,
                     source_decision_id = excluded.source_decision_id,
                     rationale = excluded.rationale,
                     updated_at = now()
       returning 1
     )
     select count(*)::text as affected_count from inserted`
  );

  const directlyResolvedIssues = await countFromQuery(
    `with resolved as (
       update reconciliation_issues ri
          set status = rdi.resolution_status,
              resolved_by_principal_id = coalesce(ri.resolved_by_principal_id, d.created_by_principal_id),
              resolved_at = coalesce(ri.resolved_at, now()),
              updated_at = now()
         from reconciliation_decision_issues rdi
         join reconciliation_decisions d on d.id = rdi.decision_id
        where ri.id = rdi.reconciliation_issue_id
          and d.status = 'active'
          and ri.status in ('open', 'assigned')
        returning 1
     )
     select count(*)::text as affected_count from resolved`
  );

  const inferredDismissedIssues = await countFromQuery(
    `with active_dismissals as (
       select d.created_by_principal_id,
              d.source_kind,
              d.source_id,
              substring(d.source_id from '#([0-9]+)$') as github_issue_number,
              ga.id as canonical_id,
              sr.id as source_record_id,
              sr.raw_payload->>'Project' as source_project,
              sr.raw_payload->>'Grantee' as source_grantee
         from reconciliation_decisions d
         left join grant_applications ga on ga.canonical_key = d.canonical_key
         left join source_records sr on sr.source_kind = d.source_kind
                                and sr.source_id = d.source_id
        where d.status = 'active'
          and d.decision_type = 'dismiss_issue'
     ),
     dismissed as (
       update reconciliation_issues ri
          set status = 'dismissed',
              resolved_by_principal_id = coalesce(ri.resolved_by_principal_id, ad.created_by_principal_id),
              resolved_at = coalesce(ri.resolved_at, now()),
              updated_at = now()
         from active_dismissals ad
        where ri.status in ('open', 'assigned')
          and (
            ri.source_record_id = ad.source_record_id
            or (
              ri.issue_type = 'unlinked_decision_minutes'
              and ad.source_kind = 'forum_link'
              and ri.details->>'linkedSourceUrl' = ad.source_id
            )
            or (
              ad.github_issue_number is not null
              and (
                ri.details->>'githubIssueNumber' = ad.github_issue_number
                or ri.details->>'issueNumber' = ad.github_issue_number
              )
            )
            or (
              ad.canonical_id is not null
              and ri.canonical_type = 'grant_application'
              and ri.canonical_id = ad.canonical_id
            )
            or (
              ri.issue_type = 'unmatched_payment_detail_without_historical_registry_match'
              and ad.source_kind = 'google_sheet_row'
              and ri.details->>'sheetProject' = ad.source_project
              and coalesce(ri.details->>'grantee', '') = coalesce(ad.source_grantee, '')
            )
          )
        returning 1
     )
     select count(*)::text as affected_count from dismissed`
  );

  const inferredResolvedIssues = await countFromQuery(
    `with active_links as (
       select d.created_by_principal_id,
              d.source_kind,
              d.source_id,
              substring(d.source_id from '#([0-9]+)$') as github_issue_number,
              ga.id as canonical_id,
              sr.id as source_record_id,
              sr.raw_payload->>'Project' as source_project,
              sr.raw_payload->>'Grantee' as source_grantee
         from reconciliation_decisions d
         join grant_applications ga on ga.canonical_key = d.canonical_key
         left join source_records sr on sr.source_kind = d.source_kind
                                and sr.source_id = d.source_id
        where d.status = 'active'
          and d.decision_type = 'link_source'
          and d.canonical_type = 'grant_application'
     ),
     resolved as (
       update reconciliation_issues ri
          set status = 'resolved',
              resolved_by_principal_id = coalesce(ri.resolved_by_principal_id, al.created_by_principal_id),
              resolved_at = coalesce(ri.resolved_at, now()),
              updated_at = now()
         from active_links al
        where ri.status in ('open', 'assigned')
          and (
            ri.source_record_id = al.source_record_id
            or (
              ri.canonical_type = 'grant_application'
              and ri.canonical_id = al.canonical_id
              and ri.issue_type in ('missing_github_source_mirror', 'missing_github_match', 'missing_historical_registry_match', 'low_confidence_historical_registry_match')
            )
            or (
              ri.issue_type in ('missing_github_source_mirror', 'missing_github_match', 'missing_historical_registry_match', 'low_confidence_historical_registry_match')
              and al.github_issue_number is not null
              and (
                ri.details->>'githubIssueNumber' = al.github_issue_number
                or ri.details->>'issueNumber' = al.github_issue_number
              )
            )
            or (
              ri.issue_type = 'unmatched_payment_detail_without_historical_registry_match'
              and al.source_kind = 'google_sheet_row'
              and ri.details->>'sheetProject' = al.source_project
              and coalesce(ri.details->>'grantee', '') = coalesce(al.source_grantee, '')
            )
          )
        returning 1
     )
     select count(*)::text as affected_count from resolved`
  );

  return {
    linkedSources,
    unlinkedSources,
    relationships,
    directlyResolvedIssues,
    inferredDismissedIssues,
    inferredResolvedIssues
  };
}

export async function getReconciliationWorkspace(): Promise<ReconciliationWorkspace> {
  const [summaryResult, issuesResult, decisionsResult, relationshipsResult] = await Promise.all([
    query<{
      open_issue_count: string;
      active_decision_count: string;
      relationship_count: string;
      linked_issue_decision_count: string;
    }>(
      `select (select count(*)::text from reconciliation_issues where status in ('open', 'assigned')) as open_issue_count,
              (select count(*)::text from reconciliation_decisions where status = 'active') as active_decision_count,
              (select count(*)::text from grant_application_relationships) as relationship_count,
              (select count(distinct decision_id)::text from reconciliation_decision_issues) as linked_issue_decision_count`
    ),
    query<ReconciliationIssueReviewRow>(
      `select ri.id::text as id,
              ri.issue_type as "issueType",
              ri.severity,
              ri.status,
              ri.summary,
              ri.details::text as details,
              sr.source_kind as "sourceKind",
              sr.source_id as "sourceId",
              sr.title as "sourceTitle",
              ga.canonical_key as "canonicalKey",
              ga.title as "canonicalTitle",
              ga.github_issue_number::text as "githubIssueNumber",
              ga.normalized_status as "normalizedStatus",
              ri.created_at::text as "createdAt",
              ri.updated_at::text as "updatedAt"
         from reconciliation_issues ri
         left join source_records sr on sr.id = ri.source_record_id
         left join grant_applications ga on ga.id = ri.canonical_id
        where ri.status in ('open', 'assigned')
        order by case ri.severity when 'error' then 0 when 'warning' then 1 else 2 end,
                 ri.created_at desc
        limit 80`
    ),
    query<ReconciliationDecisionRow>(
      `select d.id::text as id,
              d.decision_key as "decisionKey",
              d.decision_type as "decisionType",
              d.status,
              d.source_kind as "sourceKind",
              d.source_id as "sourceId",
              d.canonical_type as "canonicalType",
              d.canonical_key as "canonicalKey",
              d.related_canonical_key as "relatedCanonicalKey",
              d.relationship_type as "relationshipType",
              d.field_name as "fieldName",
              d.field_value::text as "fieldValue",
              d.rationale,
              d.confidence::text as confidence,
              d.evidence::text as evidence,
              p.email as "createdByEmail",
              d.created_at::text as "createdAt",
              d.updated_at::text as "updatedAt",
              coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'issueId', ri.id::text,
                    'status', ri.status,
                    'summary', ri.summary,
                    'resolutionStatus', rdi.resolution_status
                  )
                ) filter (where ri.id is not null),
                '[]'::jsonb
              )::text as "linkedIssues"
         from reconciliation_decisions d
         left join principals p on p.id = d.created_by_principal_id
         left join reconciliation_decision_issues rdi on rdi.decision_id = d.id
         left join reconciliation_issues ri on ri.id = rdi.reconciliation_issue_id
        group by d.id, p.email
        order by d.updated_at desc
        limit 80`
    ),
    query<GrantApplicationRelationshipRow>(
      `select gar.relationship_key as "relationshipKey",
              gar.relationship_type as "relationshipType",
              gar.rationale,
              from_ga.canonical_key as "fromCanonicalKey",
              from_ga.title as "fromTitle",
              to_ga.canonical_key as "toCanonicalKey",
              to_ga.title as "toTitle",
              d.decision_key as "sourceDecisionKey",
              gar.updated_at::text as "updatedAt"
         from grant_application_relationships gar
         join grant_applications from_ga on from_ga.id = gar.from_application_id
         join grant_applications to_ga on to_ga.id = gar.to_application_id
         left join reconciliation_decisions d on d.id = gar.source_decision_id
        order by gar.updated_at desc
        limit 80`
    )
  ]);

  const summaryRow = summaryResult.rows[0];

  return {
    summary: {
      openIssueCount: summaryRow?.open_issue_count ?? "0",
      activeDecisionCount: summaryRow?.active_decision_count ?? "0",
      relationshipCount: summaryRow?.relationship_count ?? "0",
      linkedIssueDecisionCount: summaryRow?.linked_issue_decision_count ?? "0"
    },
    openIssues: issuesResult.rows,
    decisions: decisionsResult.rows,
    relationships: relationshipsResult.rows
  };
}

export async function exportReconciliationDecisions() {
  const result = await query<DecisionExportRow>(
    `select decision_key,
            decision_type,
            status,
            source_kind,
            source_id,
            canonical_type,
            canonical_key,
            related_canonical_key,
            relationship_type,
            field_name,
            field_value,
            rationale,
            confidence::text,
            evidence,
            created_at::text,
            updated_at::text
       from reconciliation_decisions
      order by created_at, decision_key`
  );

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    decisions: result.rows.map((decision) => ({
      ...decision,
      field_value: jsonValue(decision.field_value),
      evidence: jsonValue(decision.evidence)
    }))
  };
}

export async function importReconciliationDecisions(decisions: DecisionExportRow[], actorPrincipalId: string | null = null) {
  let imported = 0;

  for (const decision of decisions) {
    await query(
      `insert into reconciliation_decisions (
         decision_key,
         decision_type,
         status,
         source_kind,
         source_id,
         canonical_type,
         canonical_key,
         related_canonical_key,
         relationship_type,
         field_name,
         field_value,
         rationale,
         confidence,
         evidence,
         created_by_principal_id,
         updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::jsonb, $15, now())
       on conflict (decision_key)
       do update set status = excluded.status,
                     source_kind = excluded.source_kind,
                     source_id = excluded.source_id,
                     canonical_type = excluded.canonical_type,
                     canonical_key = excluded.canonical_key,
                     related_canonical_key = excluded.related_canonical_key,
                     relationship_type = excluded.relationship_type,
                     field_name = excluded.field_name,
                     field_value = excluded.field_value,
                     rationale = excluded.rationale,
                     confidence = excluded.confidence,
                     evidence = excluded.evidence,
                     updated_at = now()`,
      [
        decision.decision_key,
        decision.decision_type,
        decision.status,
        decision.source_kind,
        decision.source_id,
        decision.canonical_type,
        decision.canonical_key,
        decision.related_canonical_key,
        decision.relationship_type,
        decision.field_name,
        decision.field_value === null || decision.field_value === undefined ? null : JSON.stringify(decision.field_value),
        decision.rationale,
        Number(decision.confidence),
        JSON.stringify(decision.evidence ?? {}),
        actorPrincipalId
      ]
    );
    imported += 1;
  }

  const applyResult = await applyManualReconciliationDecisions();

  return { imported, applyResult };
}
