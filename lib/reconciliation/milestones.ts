import { query } from "../db";

type QueryResultLike = {
  rows?: Array<Record<string, unknown>>;
  rowCount?: number | null;
};

type ProjectionQueryRunner = (
  text: string,
  values?: readonly unknown[]
) => Promise<QueryResultLike>;

type EligibleMilestoneSourceRow = {
  applicationId: string;
  applicationKey: string;
  applicationTitle: string;
  sourceRecordId: string;
  sourceId: string;
  sourceUrl: string | null;
  rawPayload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  matchConfidence: number;
  manuallyLinked: boolean;
};

type AmbiguousMilestoneSource = {
  sourceRecordId: string;
  summary: string;
  details: Record<string, unknown>;
};

export type ParsedGrantMilestoneSheetRow = {
  project: string | null;
  granteeName: string | null;
  category: string | null;
  reportingFrequency: string | null;
  milestoneLabel: string;
  milestoneNumber: number | null;
  milestoneType: "startup_funding" | "numbered" | "named";
  amountUsd: number | null;
  estimateText: string | null;
  estimatedAt: string | null;
  paidAt: string | null;
  zecAmount: number | null;
  usdAmount: number | null;
  exchangeRateUsdPerZec: number | null;
  grantStatus: string | null;
};

type MilestoneProjection = ParsedGrantMilestoneSheetRow & {
  applicationId: string;
  sourceRecordId: string;
  matchConfidence: number;
  linkageMethod: "reviewer_confirmed" | "exact" | "similarity";
  sourceUrl: string | null;
  sourceRowNumber: number | null;
};

export type GrantMilestoneProjectionSyncResult = {
  ok: true;
  sourceRowsSeen: number;
  sourceRowsSkipped: number;
  milestonesUpserted: number;
  disbursementsUpserted: number;
  milestonesDeleted: number;
  disbursementsDeleted: number;
  ambiguousSourceLinks: number;
};

const writeBatchSize = 100;
const generatedBy = "grant_milestone_projection_v1";
const monthNumbers = new Map<string, number>([
  ["jan", 1],
  ["january", 1],
  ["feb", 2],
  ["february", 2],
  ["mar", 3],
  ["march", 3],
  ["apr", 4],
  ["april", 4],
  ["may", 5],
  ["jun", 6],
  ["june", 6],
  ["jul", 7],
  ["july", 7],
  ["aug", 8],
  ["august", 8],
  ["sep", 9],
  ["sept", 9],
  ["september", 9],
  ["oct", 10],
  ["october", 10],
  ["nov", 11],
  ["november", 11],
  ["dec", 12],
  ["december", 12]
]);

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }

  return result;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function cellText(value: unknown) {
  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function canonicalHeader(value: string) {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function sheetField(row: Record<string, unknown>, header: string) {
  const wanted = canonicalHeader(header);

  for (const [key, value] of Object.entries(row)) {
    if (canonicalHeader(key) === wanted) {
      return value;
    }
  }

  return null;
}

function parseUnsignedDecimal(value: string) {
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/u.test(value)) {
    return null;
  }

  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseSheetNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const text = cellText(value);

  if (!text) {
    return null;
  }

  const match = text.match(/^([+-]?)(.*)$/u);
  const parsed = match ? parseUnsignedDecimal(match[2]) : null;

  if (parsed === null) {
    return null;
  }

  return match?.[1] === "-" ? -parsed : parsed;
}

export function parseSheetMoney(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  let text = cellText(value);

  if (!text) {
    return null;
  }

  let negative = false;

  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  let sign = "";

  if (text.startsWith("+") || text.startsWith("-")) {
    sign = text[0];
    text = text.slice(1);
  }

  if (text.startsWith("$")) {
    text = text.slice(1);
  }

  if (!sign && (text.startsWith("+") || text.startsWith("-"))) {
    sign = text[0];
    text = text.slice(1);
  }

  if (negative && sign) {
    return null;
  }

  const parsed = parseUnsignedDecimal(text);

  if (parsed === null) {
    return null;
  }

  return negative || sign === "-" ? -parsed : parsed;
}

function validIsoDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseSheetDate(value: unknown): string | null {
  const text = cellText(value)?.replace(/\s+/gu, " ");

  if (!text) {
    return null;
  }

  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/u);

  if (match) {
    return validIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u);

  if (match) {
    return validIsoDate(Number(match[3]), Number(match[1]), Number(match[2]));
  }

  match = text.match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/u);

  if (match) {
    const month = monthNumbers.get(match[2].toLocaleLowerCase("en-US"));
    return month ? validIsoDate(Number(match[3]), month, Number(match[1])) : null;
  }

  match = text.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/u);

  if (match) {
    const month = monthNumbers.get(match[1].toLocaleLowerCase("en-US"));
    return month ? validIsoDate(Number(match[3]), month, Number(match[2])) : null;
  }

  return null;
}

function milestoneIdentity(value: unknown) {
  const label = cellText(value)?.replace(/\s+/gu, " ");

  if (!label) {
    return null;
  }

  if (/^[1-9]\d*$/u.test(label)) {
    return {
      label,
      number: Number(label),
      type: "numbered" as const
    };
  }

  if (/^start[\s-]*up(?:\s+funding)?(?:\b|$)/iu.test(label)) {
    return {
      label,
      number: null,
      type: "startup_funding" as const
    };
  }

  return {
    label,
    number: null,
    type: "named" as const
  };
}

export function parseGrantMilestoneSheetRow(
  row: Record<string, unknown>
): ParsedGrantMilestoneSheetRow | null {
  const milestone = milestoneIdentity(sheetField(row, "Milestone"));

  if (!milestone) {
    return null;
  }

  const estimateText = cellText(sheetField(row, "Estimate"));

  return {
    project: cellText(sheetField(row, "Project")),
    granteeName: cellText(sheetField(row, "Grantee")),
    category: cellText(sheetField(row, "Category (as determined by ZCG)")),
    reportingFrequency: cellText(sheetField(row, "Reporting Frequency (as determined by ZCG)")),
    milestoneLabel: milestone.label,
    milestoneNumber: milestone.number,
    milestoneType: milestone.type,
    amountUsd: parseSheetMoney(sheetField(row, "Amount (USD)")),
    estimateText,
    estimatedAt: parseSheetDate(estimateText),
    paidAt: parseSheetDate(sheetField(row, "Paid Out")),
    zecAmount: parseSheetNumber(sheetField(row, "ZEC Disbursed")),
    usdAmount: parseSheetMoney(sheetField(row, "USD Disbursed")),
    exchangeRateUsdPerZec: parseSheetMoney(sheetField(row, "ZEC/USD")),
    grantStatus: cellText(sheetField(row, "Grant Status"))
  };
}

function sourceRowNumber(metadata: Record<string, unknown>) {
  const value = parseSheetNumber(metadata.rowNumber);
  return value !== null && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function rowSpecificSheetUrl(
  metadata: Record<string, unknown>,
  fallback: string | null
) {
  const sheetId = cellText(metadata.sheetId);
  const gid = cellText(metadata.gid);
  const rowNumber = sourceRowNumber(metadata);

  if (!sheetId || !gid || rowNumber === null) {
    return fallback;
  }

  const encodedGid = encodeURIComponent(gid);
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/edit?gid=${encodedGid}#gid=${encodedGid}&range=A${rowNumber}:L${rowNumber}`;
}

function booleanValue(value: unknown) {
  return value === true || value === "true";
}

function sourceRowFromQuery(row: Record<string, unknown>): EligibleMilestoneSourceRow {
  const confidence = parseSheetNumber(row.match_confidence);

  if (confidence === null || confidence < 0 || confidence > 1) {
    throw new Error(`Invalid milestone source-link confidence: ${String(row.match_confidence)}`);
  }

  return {
    applicationId: String(row.application_id),
    applicationKey: String(row.application_key),
    applicationTitle: String(row.application_title),
    sourceRecordId: String(row.source_record_id),
    sourceId: String(row.source_id),
    sourceUrl: cellText(row.source_url),
    rawPayload: jsonObject(row.raw_payload),
    metadata: jsonObject(row.metadata),
    matchConfidence: confidence,
    manuallyLinked: booleanValue(row.manually_linked)
  };
}

function projectionFromSource(source: EligibleMilestoneSourceRow): MilestoneProjection | null {
  const parsed = parseGrantMilestoneSheetRow(source.rawPayload);

  if (!parsed) {
    return null;
  }

  return {
    ...parsed,
    applicationId: source.applicationId,
    sourceRecordId: source.sourceRecordId,
    matchConfidence: source.matchConfidence,
    linkageMethod: source.manuallyLinked
      ? "reviewer_confirmed"
      : source.matchConfidence >= 0.9999
        ? "exact"
        : "similarity",
    sourceUrl: rowSpecificSheetUrl(source.metadata, source.sourceUrl),
    sourceRowNumber: sourceRowNumber(source.metadata)
  };
}

function emptySyncResult(): GrantMilestoneProjectionSyncResult {
  return {
    ok: true,
    sourceRowsSeen: 0,
    sourceRowsSkipped: 0,
    milestonesUpserted: 0,
    disbursementsUpserted: 0,
    milestonesDeleted: 0,
    disbursementsDeleted: 0,
    ambiguousSourceLinks: 0
  };
}

function normalizeApplicationScope(applicationIds: string[] | undefined) {
  return applicationIds === undefined
    ? null
    : [...new Set(applicationIds.map((id) => id.trim()).filter(Boolean))];
}

function selectMilestoneSources(sourceRows: EligibleMilestoneSourceRow[]) {
  const rowsBySource = new Map<string, EligibleMilestoneSourceRow[]>();

  for (const source of sourceRows) {
    const existing = rowsBySource.get(source.sourceRecordId) ?? [];
    existing.push(source);
    rowsBySource.set(source.sourceRecordId, existing);
  }

  const selected: EligibleMilestoneSourceRow[] = [];
  const ambiguous: AmbiguousMilestoneSource[] = [];

  for (const candidates of rowsBySource.values()) {
    const orderedCandidates = [...candidates].sort((left, right) =>
      left.applicationKey.localeCompare(right.applicationKey)
    );
    const reviewedCandidates = orderedCandidates.filter((candidate) => candidate.manuallyLinked);

    if (orderedCandidates.length === 1) {
      selected.push(orderedCandidates[0]);
      continue;
    }

    if (reviewedCandidates.length === 1) {
      selected.push(reviewedCandidates[0]);
      continue;
    }

    const source = orderedCandidates[0];
    const project = cellText(sheetField(source.rawPayload, "Project"));
    const rowNumber = sourceRowNumber(source.metadata);
    const sourceUrl = rowSpecificSheetUrl(source.metadata, source.sourceUrl);
    const applicationCandidates = orderedCandidates.map((candidate) => ({
      applicationId: candidate.applicationId,
      canonicalKey: candidate.applicationKey,
      title: candidate.applicationTitle,
      confidence: candidate.matchConfidence,
      manuallyLinked: candidate.manuallyLinked
    }));
    const sourceDescription = project
      ? `${project}${rowNumber ? ` (Sheet row ${rowNumber})` : ""}`
      : rowNumber
        ? `Milestone Sheet row ${rowNumber}`
        : `Milestone source ${source.sourceId}`;

    ambiguous.push({
      sourceRecordId: source.sourceRecordId,
      summary: `${sourceDescription} is linked to multiple grant applications`,
      details: {
        generatedBy,
        project,
        sourceKind: "google_sheet_row",
        sourceId: source.sourceId,
        sourceUrl,
        sourceRowNumber: rowNumber,
        candidateApplicationIds: applicationCandidates.map((candidate) => candidate.applicationId),
        candidates: applicationCandidates
      }
    });
  }

  return { selected, ambiguous };
}

async function syncAmbiguousMilestoneIssues(options: {
  ambiguous: AmbiguousMilestoneSource[];
  applicationScope: string[] | null;
  evaluatedSourceIds: string[];
  executeQuery: ProjectionQueryRunner;
}) {
  const { ambiguous, applicationScope, evaluatedSourceIds, executeQuery } = options;

  if (ambiguous.length) {
    await executeQuery(
      `/* grant_milestone_ambiguity_issues_upsert */
       with input as (
         select *
           from jsonb_to_recordset($1::jsonb) as x(
             source_record_id uuid,
             summary text,
             details jsonb
           )
       ),
       updated as (
         update reconciliation_issues issue
            set severity = 'warning',
                summary = input.summary,
                details = input.details,
                status = case
                  when issue.status = 'resolved' and issue.details->>'autoResolvedBy' = $2
                    then case when issue.assigned_principal_id is null then 'open' else 'assigned' end
                  else issue.status
                end,
                resolved_at = case
                  when issue.status = 'resolved' and issue.details->>'autoResolvedBy' = $2
                    then null
                  else issue.resolved_at
                end,
                resolved_by_principal_id = case
                  when issue.status = 'resolved' and issue.details->>'autoResolvedBy' = $2
                    then null
                  else issue.resolved_by_principal_id
                end,
                updated_at = now()
           from input
          where issue.issue_type = 'ambiguous_milestone_source_link'
            and issue.source_record_id = input.source_record_id
            and (
              issue.status in ('open', 'assigned')
              or (
                issue.status = 'resolved'
                and issue.details->>'autoResolvedBy' = $2
              )
            )
         returning issue.source_record_id
       )
       insert into reconciliation_issues (
         issue_type,
         severity,
         source_record_id,
         summary,
         details,
         status
       )
       select 'ambiguous_milestone_source_link',
              'warning',
              input.source_record_id,
              input.summary,
              input.details,
              'open'
         from input
        where not exists (
          select 1
            from reconciliation_issues existing
           where existing.issue_type = 'ambiguous_milestone_source_link'
             and existing.source_record_id = input.source_record_id
        )`,
      [
        JSON.stringify(ambiguous.map((issue) => ({
          source_record_id: issue.sourceRecordId,
          summary: issue.summary,
          details: issue.details
        }))),
        generatedBy
      ]
    );
  }

  await executeQuery(
    `/* grant_milestone_ambiguity_issues_resolve */
     update reconciliation_issues issue
        set status = 'resolved',
            resolved_at = now(),
            resolved_by_principal_id = null,
            details = issue.details || jsonb_build_object(
              'autoResolvedBy', $3::text,
              'autoResolvedAt', now()
            ),
            updated_at = now()
      where issue.issue_type = 'ambiguous_milestone_source_link'
        and issue.details->>'generatedBy' = $3
        and issue.status in ('open', 'assigned')
        and not exists (
          select 1
            from jsonb_array_elements_text($2::jsonb) active(source_record_id)
           where active.source_record_id::uuid = issue.source_record_id
        )
        and (
          $1::jsonb is null
          or (
            exists (
              select 1
                from jsonb_array_elements_text(
                  coalesce(issue.details->'candidateApplicationIds', '[]'::jsonb)
                ) candidate(application_id)
                join jsonb_array_elements_text($1::jsonb) scoped(application_id)
                  on scoped.application_id = candidate.application_id
            )
            and exists (
              select 1
                from jsonb_array_elements_text($4::jsonb) evaluated(source_record_id)
               where evaluated.source_record_id::uuid = issue.source_record_id
            )
          )
        )`,
    [
      applicationScope === null ? null : JSON.stringify(applicationScope),
      JSON.stringify(ambiguous.map((issue) => issue.sourceRecordId)),
      generatedBy,
      JSON.stringify(evaluatedSourceIds)
    ]
  );
}

function createSyncGrantMilestoneProjections(executeQuery: ProjectionQueryRunner) {
  return async function sync(
    options: { applicationIds?: string[] } = {}
  ): Promise<GrantMilestoneProjectionSyncResult> {
    const applicationScope = normalizeApplicationScope(options.applicationIds);

    if (applicationScope?.length === 0) {
      return emptySyncResult();
    }

    const scopePayload = applicationScope === null ? null : JSON.stringify(applicationScope);
    const eligibleResult = await executeQuery(
      `/* grant_milestone_projection_sources */
       with source_candidates as materialized (
         select sl.canonical_id as application_id,
                linked_application.canonical_key as application_key,
                linked_application.title as application_title,
                sr.id as source_record_id,
                sr.source_id,
                sr.source_url,
                sr.raw_payload,
                sr.metadata,
                sl.confidence as match_confidence,
                exists (
                  select 1
                    from reconciliation_decisions rd
                    join grant_applications reviewed_application
                      on reviewed_application.canonical_key = rd.canonical_key
                   where rd.status = 'active'
                     and rd.decision_type = $2
                     and rd.canonical_type = 'grant_application'
                     and rd.source_kind = sr.source_kind
                     and rd.source_id = sr.source_id
                     and reviewed_application.id = sl.canonical_id
                ) as manually_linked
           from source_links sl
           join source_records sr on sr.id = sl.source_record_id
           join grant_applications linked_application on linked_application.id = sl.canonical_id
          where sl.canonical_type = 'grant_application'
            and sr.source_kind = 'google_sheet_row'
            and lower(coalesce(sr.metadata->>'tabName', '')) = 'milestone_details'
       ),
       eligible as (
         select *
           from source_candidates
          where match_confidence >= 0.92 or manually_linked
       )
       select candidate.application_id::text as application_id,
              candidate.application_key,
              candidate.application_title,
              candidate.source_record_id::text as source_record_id,
              candidate.source_id,
              candidate.source_url,
              candidate.raw_payload::text as raw_payload,
              candidate.metadata::text as metadata,
              candidate.match_confidence::text as match_confidence,
              candidate.manually_linked
         from eligible candidate
        where (
          $1::jsonb is null
          or exists (
            select 1
              from eligible scoped_candidate
              join jsonb_array_elements_text($1::jsonb) scoped(application_id)
                on scoped.application_id::uuid = scoped_candidate.application_id
             where scoped_candidate.source_record_id = candidate.source_record_id
          )
        )
        order by candidate.source_record_id, candidate.application_key`,
      [scopePayload, "link_source"]
    );
    const sourceRows = (eligibleResult.rows ?? []).map(sourceRowFromQuery);
    const { selected: selectedSources, ambiguous } = selectMilestoneSources(sourceRows);
    const projections = selectedSources
      .map(projectionFromSource)
      .filter((projection): projection is MilestoneProjection => projection !== null);

    await syncAmbiguousMilestoneIssues({
      ambiguous,
      applicationScope,
      evaluatedSourceIds: [...new Set(sourceRows.map((source) => source.sourceRecordId))],
      executeQuery
    });

    const milestoneIdsBySource = new Map<string, string>();

    for (const batch of chunks(projections, writeBatchSize)) {
      const payload = batch.map((projection) => ({
        application_id: projection.applicationId,
        source_record_id: projection.sourceRecordId,
        milestone_label: projection.milestoneLabel,
        milestone_number: projection.milestoneNumber,
        milestone_type: projection.milestoneType,
        reporting_frequency: projection.reportingFrequency,
        category: projection.category,
        grantee_name: projection.granteeName,
        amount_usd: projection.amountUsd,
        estimate_text: projection.estimateText,
        estimated_at: projection.estimatedAt,
        grant_status: projection.grantStatus,
        match_confidence: projection.matchConfidence,
        linkage_method: projection.linkageMethod,
        source_url: projection.sourceUrl,
        source_row_number: projection.sourceRowNumber
      }));
      const upsertResult = await executeQuery(
        `/* grant_milestones_upsert */
         insert into grant_milestones (
           application_id,
           source_record_id,
           milestone_label,
           milestone_number,
           milestone_type,
           reporting_frequency,
           category,
           grantee_name,
           amount_usd,
           estimate_text,
           estimated_at,
           grant_status,
           match_confidence,
           linkage_method,
           source_url,
           source_row_number,
           updated_at
         )
         select application_id,
                source_record_id,
                milestone_label,
                milestone_number,
                milestone_type,
                reporting_frequency,
                category,
                grantee_name,
                amount_usd,
                estimate_text,
                estimated_at,
                grant_status,
                match_confidence,
                linkage_method,
                source_url,
                source_row_number,
                now()
           from jsonb_to_recordset($1::jsonb) as x(
             application_id uuid,
             source_record_id uuid,
             milestone_label text,
             milestone_number integer,
             milestone_type text,
             reporting_frequency text,
             category text,
             grantee_name text,
             amount_usd numeric,
             estimate_text text,
             estimated_at date,
             grant_status text,
             match_confidence numeric,
             linkage_method text,
             source_url text,
             source_row_number integer
           )
         on conflict (source_record_id)
         do update set application_id = excluded.application_id,
                       milestone_label = excluded.milestone_label,
                       milestone_number = excluded.milestone_number,
                       milestone_type = excluded.milestone_type,
                       reporting_frequency = excluded.reporting_frequency,
                       category = excluded.category,
                       grantee_name = excluded.grantee_name,
                       amount_usd = excluded.amount_usd,
                       estimate_text = excluded.estimate_text,
                       estimated_at = excluded.estimated_at,
                       grant_status = excluded.grant_status,
                       match_confidence = excluded.match_confidence,
                       linkage_method = excluded.linkage_method,
                       source_url = excluded.source_url,
                       source_row_number = excluded.source_row_number,
                       updated_at = now()
         returning id::text as id, source_record_id::text as source_record_id`,
        [JSON.stringify(payload)]
      );

      for (const row of upsertResult.rows ?? []) {
        milestoneIdsBySource.set(String(row.source_record_id), String(row.id));
      }
    }

    if (milestoneIdsBySource.size !== projections.length) {
      throw new Error(
        `Expected ${projections.length} milestone upsert results, received ${milestoneIdsBySource.size}`
      );
    }

    const disbursements = projections.filter(
      (projection) =>
        projection.paidAt !== null ||
        projection.zecAmount !== null ||
        projection.usdAmount !== null
    );

    for (const batch of chunks(disbursements, writeBatchSize)) {
      const payload = batch.map((projection) => ({
        milestone_id: milestoneIdsBySource.get(projection.sourceRecordId),
        application_id: projection.applicationId,
        source_record_id: projection.sourceRecordId,
        paid_at: projection.paidAt,
        zec_amount: projection.zecAmount,
        usd_amount: projection.usdAmount,
        exchange_rate_usd_per_zec: projection.exchangeRateUsdPerZec,
        source_url: projection.sourceUrl
      }));
      await executeQuery(
        `/* grant_disbursements_upsert */
         insert into grant_disbursements (
           milestone_id,
           application_id,
           source_record_id,
           paid_at,
           zec_amount,
           usd_amount,
           exchange_rate_usd_per_zec,
           source_url,
           updated_at
         )
         select milestone_id,
                application_id,
                source_record_id,
                paid_at,
                zec_amount,
                usd_amount,
                exchange_rate_usd_per_zec,
                source_url,
                now()
           from jsonb_to_recordset($1::jsonb) as x(
             milestone_id uuid,
             application_id uuid,
             source_record_id uuid,
             paid_at date,
             zec_amount numeric,
             usd_amount numeric,
             exchange_rate_usd_per_zec numeric,
             source_url text
           )
         on conflict (source_record_id)
         do update set milestone_id = excluded.milestone_id,
                       application_id = excluded.application_id,
                       paid_at = excluded.paid_at,
                       zec_amount = excluded.zec_amount,
                       usd_amount = excluded.usd_amount,
                       exchange_rate_usd_per_zec = excluded.exchange_rate_usd_per_zec,
                       source_url = excluded.source_url,
                       updated_at = now()`,
        [JSON.stringify(payload)]
      );
    }

    const currentMilestoneSourceIds = projections.map((projection) => projection.sourceRecordId);
    const currentDisbursementSourceIds = disbursements.map((projection) => projection.sourceRecordId);
    const ambiguousSourceIds = ambiguous.map((issue) => issue.sourceRecordId);
    // A targeted query deliberately pulls every candidate for a source that
    // touches the requested application so ambiguity can be evaluated safely.
    // Those additional candidates do not widen the cleanup scope: doing so
    // could delete unrelated projections for another candidate application
    // whose other sources were not loaded by this targeted run. Ambiguous
    // source IDs are handled explicitly below regardless of attachment.
    const cleanupScopePayload = applicationScope === null
      ? null
      : JSON.stringify(applicationScope);
    const deletedDisbursements = await executeQuery(
      `/* grant_disbursements_delete_stale */
       delete from grant_disbursements disbursement
        using source_records source
        where source.id = disbursement.source_record_id
          and source.source_kind = 'google_sheet_row'
          and lower(coalesce(source.metadata->>'tabName', '')) = 'milestone_details'
          and (
            $1::jsonb is null
            or exists (
              select 1
                from jsonb_array_elements_text($1::jsonb) scoped(application_id)
               where scoped.application_id::uuid = disbursement.application_id
            )
            or exists (
              select 1
                from jsonb_array_elements_text($3::jsonb) ambiguous(source_record_id)
               where ambiguous.source_record_id::uuid = disbursement.source_record_id
            )
          )
          and not exists (
            select 1
              from jsonb_array_elements_text($2::jsonb) current_source(source_record_id)
             where current_source.source_record_id::uuid = disbursement.source_record_id
          )`,
      [
        cleanupScopePayload,
        JSON.stringify(currentDisbursementSourceIds),
        JSON.stringify(ambiguousSourceIds)
      ]
    );
    const deletedMilestones = await executeQuery(
      `/* grant_milestones_delete_stale */
       delete from grant_milestones milestone
        using source_records source
        where source.id = milestone.source_record_id
          and source.source_kind = 'google_sheet_row'
          and lower(coalesce(source.metadata->>'tabName', '')) = 'milestone_details'
          and (
            $1::jsonb is null
            or exists (
              select 1
                from jsonb_array_elements_text($1::jsonb) scoped(application_id)
               where scoped.application_id::uuid = milestone.application_id
            )
            or exists (
              select 1
                from jsonb_array_elements_text($3::jsonb) ambiguous(source_record_id)
               where ambiguous.source_record_id::uuid = milestone.source_record_id
            )
          )
          and not exists (
            select 1
              from jsonb_array_elements_text($2::jsonb) current_source(source_record_id)
             where current_source.source_record_id::uuid = milestone.source_record_id
          )`,
      [
        cleanupScopePayload,
        JSON.stringify(currentMilestoneSourceIds),
        JSON.stringify(ambiguousSourceIds)
      ]
    );

    return {
      ok: true,
      sourceRowsSeen: sourceRows.length,
      sourceRowsSkipped: sourceRows.length - projections.length,
      milestonesUpserted: projections.length,
      disbursementsUpserted: disbursements.length,
      milestonesDeleted: deletedMilestones.rowCount ?? 0,
      disbursementsDeleted: deletedDisbursements.rowCount ?? 0,
      ambiguousSourceLinks: ambiguous.length
    };
  };
}

const executeProjectionQuery: ProjectionQueryRunner = async (text, values = []) =>
  query(text, values);

export const syncGrantMilestoneProjections = createSyncGrantMilestoneProjections(
  executeProjectionQuery
);

export const milestoneProjectionTestHooks = {
  createSyncGrantMilestoneProjections,
  rowSpecificSheetUrl,
  sourceRowNumber
};
