import { query } from "../db";

type RawSourceRecord = {
  id: string;
  source_kind: string;
  source_id: string;
  source_url: string | null;
  title: string | null;
  summary: string | null;
  source_updated_at: string | null;
  raw_payload: string;
  metadata: string;
};

type GitHubApplication = {
  sourceRecord: RawSourceRecord;
  key: string;
  title: string;
  displayTitle: string;
  applicantName: string | null;
  issueNumber: number | null;
  issueUrl: string | null;
  state: string | null;
  requestedAmountUsd: number | null;
  labels: string[];
};

type SheetProjectGroup = {
  key: string;
  project: string;
  grantee: string | null;
  status: string | null;
  category: string | null;
  requestedAmountUsd: number | null;
  paidAmountUsd: number | null;
  rows: RawSourceRecord[];
};

type ApplicationInput = {
  canonicalKey: string;
  title: string;
  applicantName: string | null;
  githubIssueNumber: number | null;
  githubIssueUrl: string | null;
  githubState: string | null;
  normalizedStatus: string;
  requestedAmountUsd: number | null;
  matchConfidence: number;
  sourceSummary: Record<string, unknown>;
};

type GrantInput = {
  applicationId: string;
  title: string;
  granteeName: string | null;
  status: string;
  approvedAmountUsd: number | null;
};

type SourceLinkInput = {
  sourceRecordId: string;
  canonicalId: string;
  confidence: number;
};

type ReconciliationIssueInput = {
  issueType: string;
  severity: "info" | "warning" | "error";
  sourceRecordId?: string | null;
  canonicalId?: string | null;
  summary: string;
  details: Record<string, unknown>;
};

type ForumLinkInput = {
  url: string;
  title: string;
  summary: string;
  discoveredFrom: string[];
};

type PlannedApplication = {
  application: ApplicationInput;
  links: Omit<SourceLinkInput, "canonicalId">[];
  forumLinks: ForumLinkInput[];
  grant: Omit<GrantInput, "applicationId"> | null;
  issues: Omit<ReconciliationIssueInput, "canonicalId">[];
};

export type ReconciliationRunResult = {
  ok: true;
  applicationsCreatedOrUpdated: number;
  grantsCreatedOrUpdated: number;
  linksCreated: number;
  issuesCreated: number;
  forumLinksCreatedOrUpdated: number;
  matchedApplications: number;
  unmatchedGitHubApplications: number;
  unmatchedSheetProjects: number;
};

const generatedBy = "grant_reconciliation_v1";
const sourceRecordBatchSize = 10;
const writeBatchSize = 100;
const forumUrlPattern = /https?:\/\/forum\.zcashcommunity\.com\/t\/[^\s)"'<\]}]+/gi;
const genericForumTopicSlugs = new Set(["zcg-code-of-conduct", "zcg-communication-guidelines"]);

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/[$,\s]/g, "");
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function collectStringValues(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    return [value];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringValues(entry, depth + 1));
  }

  if (typeof value === "object") {
    return Object.values(value).flatMap((entry) => collectStringValues(entry, depth + 1));
  }

  return [];
}

function normalizeForumUrl(value: string) {
  const trimmed = value.replace(/[.,;:]+$/g, "").replace(/\/+$/g, "");

  try {
    const parsed = new URL(trimmed);

    if (parsed.hostname !== "forum.zcashcommunity.com" || !parsed.pathname.startsWith("/t/")) {
      return null;
    }

    const slug = parsed.pathname.split("/").filter(Boolean)[1];

    if (!slug || genericForumTopicSlugs.has(slug)) {
      return null;
    }

    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/g, "");
    return parsed.toString();
  } catch {
    return null;
  }
}

function forumTitleFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    const slug = parsed.pathname.split("/").filter(Boolean)[1];

    if (slug) {
      return `Forum thread: ${decodeURIComponent(slug).replace(/-/g, " ")}`;
    }
  } catch {
    return "Forum thread";
  }

  return "Forum thread";
}

function forumLinksFromRecord(record: RawSourceRecord) {
  const raw = parseJsonRecord(record.raw_payload);
  const values = [
    record.title,
    record.summary,
    record.source_url,
    ...collectStringValues(raw)
  ].filter((value): value is string => typeof value === "string");
  const urls = new Map<string, ForumLinkInput>();

  for (const value of values) {
    const matches = value.match(forumUrlPattern) ?? [];

    for (const match of matches) {
      const url = normalizeForumUrl(match);

      if (!url || urls.has(url)) {
        continue;
      }

      urls.set(url, {
        url,
        title: forumTitleFromUrl(url),
        summary: `Forum link discovered in ${record.source_kind} ${record.source_id}`,
        discoveredFrom: [`${record.source_kind}:${record.source_id}`]
      });
    }
  }

  return [...urls.values()];
}

function mergeForumLinks(records: RawSourceRecord[]) {
  const links = new Map<string, ForumLinkInput>();

  for (const record of records) {
    for (const link of forumLinksFromRecord(record)) {
      const existing = links.get(link.url);

      if (existing) {
        existing.discoveredFrom = [...new Set([...existing.discoveredFrom, ...link.discoveredFrom])];
        continue;
      }

      links.set(link.url, link);
    }
  }

  return [...links.values()];
}

function gitHubCommentIssueSourceId(record: RawSourceRecord) {
  const metadata = parseJsonRecord(record.metadata);
  const issueSourceId = stringValue(metadata.issueSourceId);

  if (issueSourceId) {
    return issueSourceId;
  }

  const owner = stringValue(metadata.owner);
  const repo = stringValue(metadata.repo);
  const issueNumber = numberValue(metadata.issueNumber) ?? numberValue(metadata.number);

  return owner && repo && issueNumber ? `${owner}/${repo}#${issueNumber}` : null;
}

function buildGitHubCommentsByIssue(records: RawSourceRecord[]) {
  const byIssue = new Map<string, RawSourceRecord[]>();

  for (const record of records) {
    const issueSourceId = gitHubCommentIssueSourceId(record);

    if (!issueSourceId) {
      continue;
    }

    const comments = byIssue.get(issueSourceId) ?? [];
    comments.push(record);
    byIssue.set(issueSourceId, comments);
  }

  return byIssue;
}

function normalizeTitle(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/^zcg\s+application\s+draft\s+(?:\u2014|-)\s*/i, "")
    .replace(/^grant\s+application\s+(?:\u2014|-|:)\s*/i, "")
    .replace(/^zcg\s+grant\s+application\s+(?:\u2014|-|:)\s*/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function titleTokens(value: string) {
  return new Set(
    normalizeTitle(value)
      .split(" ")
      .filter((token) => token.length > 2)
  );
}

function jaccard(left: string, right: string) {
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);

  if (!leftTokens.size || !rightTokens.size) {
    return 0;
  }

  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function statusFromGitHub(app: GitHubApplication) {
  const labelText = app.labels.join(" ").toLowerCase();

  if (labelText.includes("approved")) {
    return "approved";
  }

  if (labelText.includes("rejected") || labelText.includes("declined")) {
    return "declined";
  }

  if (labelText.includes("ready")) {
    return "under_review";
  }

  if (app.state === "closed") {
    return "closed";
  }

  return "submitted";
}

function statusFromSheet(status: string | null) {
  const normalized = (status ?? "").toLowerCase();

  if (normalized.includes("complete")) {
    return "completed";
  }

  if (normalized.includes("cancel")) {
    return "cancelled";
  }

  if (normalized.includes("active") || normalized.includes("progress")) {
    return "active";
  }

  if (normalized.includes("approved")) {
    return "approved";
  }

  if (normalized.includes("reject") || normalized.includes("decline")) {
    return "declined";
  }

  return normalized ? normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") : "unknown";
}

function extractMarkdownSection(body: string | null, heading: string) {
  if (!body) {
    return null;
  }

  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`###\\s+${escaped}\\s*\\n+([\\s\\S]*?)(?=\\n###\\s+|$)`, "i");
  const match = body.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function parseGitHubApplication(record: RawSourceRecord): GitHubApplication | null {
  const raw = parseJsonRecord(record.raw_payload);
  const metadata = parseJsonRecord(record.metadata);
  const title = stringValue(raw.title) ?? record.title ?? "";
  const normalized = normalizeTitle(title);
  const labels = Array.isArray(metadata.labels)
    ? metadata.labels.filter((label): label is string => typeof label === "string")
    : [];

  if (!normalized || (!title.toLowerCase().includes("grant") && !labels.some((label) => label.includes("Grant")))) {
    return null;
  }

  const body = stringValue(raw.body);
  const organizationName = extractMarkdownSection(body, "Organization Name");
  const applicantName =
    organizationName ??
    extractMarkdownSection(body, "Application Owners (@Octocat, @Octocat1)") ??
    stringValue(metadata.author);
  const requestedAmountUsd = numberValue(extractMarkdownSection(body, "Requested Grant Amount (USD)"));

  return {
    sourceRecord: record,
    key: normalizeTitle(title),
    title,
    displayTitle: title.replace(/^Grant Application\s+(?:\u2014|-|:)\s*/i, "").trim() || title,
    applicantName,
    issueNumber: typeof metadata.number === "number" ? metadata.number : numberValue(metadata.number),
    issueUrl: stringValue(raw.html_url) ?? record.source_url,
    state: stringValue(metadata.state),
    requestedAmountUsd,
    labels
  };
}

function sheetField(row: Record<string, unknown>, field: string) {
  const direct = stringValue(row[field]);

  if (direct) {
    return direct;
  }

  const normalizedField = field.replace(/\s+/g, " ").trim().toLowerCase();
  const found = Object.entries(row).find(([key]) => key.replace(/\s+/g, " ").trim().toLowerCase() === normalizedField);
  return found ? stringValue(found[1]) : null;
}

function buildSheetGroups(records: RawSourceRecord[]) {
  const groups = new Map<string, SheetProjectGroup>();

  for (const record of records) {
    const raw = parseJsonRecord(record.raw_payload);
    const project = sheetField(raw, "Project") ?? record.title;

    if (!project) {
      continue;
    }

    const key = normalizeTitle(project);

    if (!key) {
      continue;
    }

    const amount = numberValue(sheetField(raw, "Amount (USD)"));
    const paid = numberValue(sheetField(raw, "USD Disbursed"));
    const current = groups.get(key);

    if (current) {
      current.rows.push(record);
      current.requestedAmountUsd = Math.max(current.requestedAmountUsd ?? 0, amount ?? 0) || current.requestedAmountUsd;
      current.paidAmountUsd = (current.paidAmountUsd ?? 0) + (paid ?? 0);
      current.status ||= sheetField(raw, "Grant Status");
      current.category ||= sheetField(raw, "Category \n(as determined by ZCG)");
      continue;
    }

    groups.set(key, {
      key,
      project,
      grantee: sheetField(raw, "Grantee"),
      status: sheetField(raw, "Grant Status"),
      category: sheetField(raw, "Category \n(as determined by ZCG)"),
      requestedAmountUsd: amount,
      paidAmountUsd: paid,
      rows: [record]
    });
  }

  return groups;
}

function bestSheetMatch(app: GitHubApplication, sheetGroups: Map<string, SheetProjectGroup>) {
  const exact = sheetGroups.get(app.key);

  if (exact) {
    return { group: exact, confidence: 1 };
  }

  let best: { group: SheetProjectGroup; confidence: number } | null = null;

  for (const group of sheetGroups.values()) {
    const confidence = Math.max(jaccard(app.displayTitle, group.project), jaccard(app.title, group.project));

    if (!best || confidence > best.confidence) {
      best = { group, confidence };
    }
  }

  return best && best.confidence >= 0.72 ? best : null;
}

async function fetchSourceRecords(sourceKind: "github_issue" | "github_issue_comment" | "google_sheet_row") {
  const records: RawSourceRecord[] = [];
  let offset = 0;

  while (true) {
    const result = await query<RawSourceRecord>(
      `select id,
              source_kind,
              source_id,
              source_url,
              title,
              summary,
              source_updated_at,
              raw_payload::text as raw_payload,
              metadata::text as metadata
         from source_records
        where source_kind = $1
        order by source_id
        limit $2 offset $3`,
      [sourceKind, sourceRecordBatchSize, offset]
    );

    records.push(...result.rows);

    if (result.rows.length < sourceRecordBatchSize) {
      break;
    }

    offset += sourceRecordBatchSize;
  }

  return records;
}

async function bulkUpsertApplications(applications: ApplicationInput[]) {
  const idsByCanonicalKey = new Map<string, string>();

  for (const batch of chunkArray(applications, writeBatchSize)) {
    const payload = batch.map((application) => ({
      canonical_key: application.canonicalKey,
      title: application.title,
      applicant_name: application.applicantName,
      github_issue_number: application.githubIssueNumber,
      github_issue_url: application.githubIssueUrl,
      github_state: application.githubState,
      normalized_status: application.normalizedStatus,
      requested_amount_usd: application.requestedAmountUsd,
      match_confidence: application.matchConfidence,
      source_summary: application.sourceSummary
    }));

    const result = await query<{ canonical_key: string; id: string }>(
      `with input as (
         select *
           from jsonb_to_recordset($1::jsonb) as x(
             canonical_key text,
             title text,
             applicant_name text,
             github_issue_number integer,
             github_issue_url text,
             github_state text,
             normalized_status text,
             requested_amount_usd numeric,
             match_confidence numeric,
             source_summary jsonb
           )
       ),
       upserted as (
         insert into grant_applications (
           canonical_key,
           title,
           applicant_name,
           github_issue_number,
           github_issue_url,
           github_state,
           normalized_status,
           requested_amount_usd,
           match_confidence,
           source_summary,
           updated_at
         )
         select canonical_key,
                title,
                applicant_name,
                github_issue_number,
                github_issue_url,
                github_state,
                normalized_status,
                requested_amount_usd,
                match_confidence,
                coalesce(source_summary, '{}'::jsonb),
                now()
           from input
         on conflict (canonical_key)
         do update set title = excluded.title,
                       applicant_name = excluded.applicant_name,
                       github_issue_number = excluded.github_issue_number,
                       github_issue_url = excluded.github_issue_url,
                       github_state = excluded.github_state,
                       normalized_status = excluded.normalized_status,
                       requested_amount_usd = excluded.requested_amount_usd,
                       match_confidence = excluded.match_confidence,
                       source_summary = excluded.source_summary,
                       updated_at = now()
         returning canonical_key, id
       )
       select canonical_key, id from upserted`,
      [JSON.stringify(payload)]
    );

    for (const row of result.rows) {
      idsByCanonicalKey.set(row.canonical_key, row.id);
    }
  }

  return idsByCanonicalKey;
}

async function bulkUpsertGrants(grants: GrantInput[]) {
  for (const batch of chunkArray(grants, writeBatchSize)) {
    const payload = batch.map((grant) => ({
      application_id: grant.applicationId,
      title: grant.title,
      grantee_name: grant.granteeName,
      status: grant.status,
      approved_amount_usd: grant.approvedAmountUsd
    }));

    await query(
      `insert into grants (application_id, title, grantee_name, status, approved_amount_usd, updated_at)
       select application_id, title, grantee_name, status, approved_amount_usd, now()
         from jsonb_to_recordset($1::jsonb) as x(
           application_id uuid,
           title text,
           grantee_name text,
           status text,
           approved_amount_usd numeric
         )
       on conflict (application_id)
       do update set title = excluded.title,
                     grantee_name = excluded.grantee_name,
                     status = excluded.status,
                     approved_amount_usd = excluded.approved_amount_usd,
                     updated_at = now()`,
      [JSON.stringify(payload)]
    );
  }

  return grants.length;
}

async function bulkUpsertForumSourceRecords(forumLinks: ForumLinkInput[]) {
  const idsByUrl = new Map<string, string>();
  const uniqueLinks = [...new Map(forumLinks.map((link) => [link.url, link])).values()];

  for (const batch of chunkArray(uniqueLinks, writeBatchSize)) {
    const payload = batch.map((link) => ({
      url: link.url,
      title: link.title,
      summary: link.summary,
      raw_payload: {
        url: link.url,
        discoveredFrom: link.discoveredFrom
      },
      metadata: {
        source: "reconciliation",
        generatedBy,
        discoveredFrom: link.discoveredFrom
      }
    }));

    const result = await query<{ source_id: string; id: string }>(
      `insert into source_records (
         source_kind,
         source_id,
         source_url,
         title,
         summary,
         raw_payload,
         metadata,
         updated_at
       )
       select 'forum_link',
              url,
              url,
              title,
              summary,
              coalesce(raw_payload, '{}'::jsonb),
              coalesce(metadata, '{}'::jsonb),
              now()
         from jsonb_to_recordset($1::jsonb) as x(
           url text,
           title text,
           summary text,
           raw_payload jsonb,
           metadata jsonb
         )
       on conflict (source_kind, source_id)
       do update set source_url = excluded.source_url,
                     title = excluded.title,
                     summary = excluded.summary,
                     raw_payload = excluded.raw_payload,
                     metadata = excluded.metadata,
                     updated_at = now()
       returning source_id, id`,
      [JSON.stringify(payload)]
    );

    for (const row of result.rows) {
      idsByUrl.set(row.source_id, row.id);
    }
  }

  return idsByUrl;
}

async function bulkLinkSources(links: SourceLinkInput[]) {
  for (const batch of chunkArray(links, writeBatchSize)) {
    const payload = batch.map((link) => ({
      source_record_id: link.sourceRecordId,
      canonical_id: link.canonicalId,
      confidence: link.confidence
    }));

    await query(
      `insert into source_links (source_record_id, canonical_type, canonical_id, confidence)
       select source_record_id, 'grant_application', canonical_id, confidence
         from jsonb_to_recordset($1::jsonb) as x(
           source_record_id uuid,
           canonical_id uuid,
           confidence numeric
         )
       on conflict (source_record_id, canonical_type, canonical_id)
       do update set confidence = excluded.confidence`,
      [JSON.stringify(payload)]
    );
  }

  return links.length;
}

async function bulkCreateIssues(issues: ReconciliationIssueInput[]) {
  for (const batch of chunkArray(issues, writeBatchSize)) {
    const payload = batch.map((issue) => ({
      issue_type: issue.issueType,
      severity: issue.severity,
      source_record_id: issue.sourceRecordId ?? null,
      canonical_id: issue.canonicalId ?? null,
      summary: issue.summary,
      details: { generatedBy, ...issue.details }
    }));

    await query(
      `insert into reconciliation_issues (
         issue_type,
         severity,
         source_record_id,
         canonical_type,
         canonical_id,
         summary,
         details
       )
       select issue_type,
              severity,
              source_record_id,
              'grant_application',
              canonical_id,
              summary,
              coalesce(details, '{}'::jsonb)
         from jsonb_to_recordset($1::jsonb) as x(
           issue_type text,
           severity text,
           source_record_id uuid,
           canonical_id uuid,
           summary text,
           details jsonb
         )`,
      [JSON.stringify(payload)]
    );
  }

  return issues.length;
}

export async function runGrantReconciliation(): Promise<ReconciliationRunResult> {
  const [githubRecords, githubCommentRecords, sheetRecords] = await Promise.all([
    fetchSourceRecords("github_issue"),
    fetchSourceRecords("github_issue_comment"),
    fetchSourceRecords("google_sheet_row")
  ]);

  const githubApplications = githubRecords
    .map(parseGitHubApplication)
    .filter((app): app is GitHubApplication => Boolean(app));
  const githubCommentsByIssue = buildGitHubCommentsByIssue(githubCommentRecords);
  const sheetGroups = buildSheetGroups(sheetRecords);
  const matchedSheetKeys = new Set<string>();

  await query(
    `delete from reconciliation_issues
      where details->>'generatedBy' = $1
        and status = 'open'`,
    [generatedBy]
  );
  await query(`delete from source_links where canonical_type = 'grant_application'`);
  await query(
    `delete from source_records
      where source_kind = 'forum_link'
        and metadata->>'generatedBy' = $1`,
    [generatedBy]
  );

  const counts: ReconciliationRunResult = {
    ok: true,
    applicationsCreatedOrUpdated: 0,
    grantsCreatedOrUpdated: 0,
    linksCreated: 0,
    issuesCreated: 0,
    forumLinksCreatedOrUpdated: 0,
    matchedApplications: 0,
    unmatchedGitHubApplications: 0,
    unmatchedSheetProjects: 0
  };
  const plannedApplications: PlannedApplication[] = [];

  for (const app of githubApplications) {
    const match = bestSheetMatch(app, sheetGroups);
    const githubComments = githubCommentsByIssue.get(app.sourceRecord.source_id) ?? [];
    const sheetStatus = match?.group.status ? statusFromSheet(match.group.status) : null;
    const normalizedStatus = sheetStatus && sheetStatus !== "unknown" ? sheetStatus : statusFromGitHub(app);
    const requestedAmountUsd = app.requestedAmountUsd ?? match?.group.requestedAmountUsd ?? null;
    const planned: PlannedApplication = {
      application: {
        canonicalKey: `github:${app.sourceRecord.source_id}`,
        title: app.displayTitle,
        applicantName: app.applicantName ?? match?.group.grantee ?? null,
        githubIssueNumber: app.issueNumber,
        githubIssueUrl: app.issueUrl,
        githubState: app.state,
        normalizedStatus,
        requestedAmountUsd,
        matchConfidence: match?.confidence ?? 0,
        sourceSummary: {
          githubSourceId: app.sourceRecord.source_id,
          githubLabels: app.labels,
          githubCommentCount: githubComments.length,
          sheetProject: match?.group.project ?? null,
          sheetRowCount: match?.group.rows.length ?? 0,
          sheetCategory: match?.group.category ?? null,
          sheetPaidAmountUsd: match?.group.paidAmountUsd ?? null
        }
      },
      links: [
        { sourceRecordId: app.sourceRecord.id, confidence: 1 },
        ...githubComments.map((record) => ({ sourceRecordId: record.id, confidence: 1 }))
      ],
      forumLinks: mergeForumLinks([app.sourceRecord, ...githubComments]),
      grant: null,
      issues: []
    };

    counts.applicationsCreatedOrUpdated += 1;

    if (match) {
      matchedSheetKeys.add(match.group.key);
      counts.matchedApplications += 1;
      planned.forumLinks = mergeForumLinks([app.sourceRecord, ...githubComments, ...match.group.rows]);

      for (const row of match.group.rows) {
        planned.links.push({ sourceRecordId: row.id, confidence: match.confidence });
      }

      planned.grant = {
        title: app.displayTitle,
        granteeName: match.group.grantee ?? app.applicantName,
        status: normalizedStatus,
        approvedAmountUsd: match.group.requestedAmountUsd
      };

      if (match.confidence < 0.92) {
        planned.issues.push({
          issueType: "low_confidence_match",
          severity: "warning",
          sourceRecordId: app.sourceRecord.id,
          summary: `Review possible Sheet match for ${app.displayTitle}`,
          details: {
            githubTitle: app.title,
            sheetProject: match.group.project,
            confidence: match.confidence
          }
        });
      }

      if (app.state === "open" && ["completed", "cancelled", "declined"].includes(normalizedStatus)) {
        planned.issues.push({
          issueType: "status_conflict",
          severity: "warning",
          sourceRecordId: app.sourceRecord.id,
          summary: `GitHub is open but Sheet status is ${match.group.status}`,
          details: {
            githubState: app.state,
            sheetStatus: match.group.status,
            normalizedStatus
          }
        });
      }
    } else {
      counts.unmatchedGitHubApplications += 1;
      planned.issues.push({
        issueType: "missing_sheet_match",
        severity: "info",
        sourceRecordId: app.sourceRecord.id,
        summary: `No Sheet project match found for ${app.displayTitle}`,
        details: {
          githubTitle: app.title,
          issueNumber: app.issueNumber,
          issueUrl: app.issueUrl
        }
      });
    }

    plannedApplications.push(planned);
  }

  for (const group of sheetGroups.values()) {
    if (matchedSheetKeys.has(group.key)) {
      continue;
    }

    const planned: PlannedApplication = {
      application: {
        canonicalKey: `sheet:${group.key}`,
        title: group.project,
        applicantName: group.grantee,
        githubIssueNumber: null,
        githubIssueUrl: null,
        githubState: null,
        normalizedStatus: statusFromSheet(group.status),
        requestedAmountUsd: group.requestedAmountUsd,
        matchConfidence: 0,
        sourceSummary: {
          sheetProject: group.project,
          sheetRowCount: group.rows.length,
          sheetCategory: group.category,
          sheetPaidAmountUsd: group.paidAmountUsd
        }
      },
      links: group.rows.map((row) => ({ sourceRecordId: row.id, confidence: 1 })),
      forumLinks: mergeForumLinks(group.rows),
      grant: {
        title: group.project,
        granteeName: group.grantee,
        status: statusFromSheet(group.status),
        approvedAmountUsd: group.requestedAmountUsd
      },
      issues: [
        {
          issueType: "missing_github_match",
          severity: "info",
          sourceRecordId: group.rows[0]?.id,
          summary: `No GitHub application match found for Sheet project ${group.project}`,
          details: {
            sheetProject: group.project,
            grantee: group.grantee,
            rowCount: group.rows.length,
            status: group.status
          }
        }
      ]
    };

    plannedApplications.push(planned);
    counts.applicationsCreatedOrUpdated += 1;
    counts.unmatchedSheetProjects += 1;
  }

  const applicationIds = await bulkUpsertApplications(plannedApplications.map((planned) => planned.application));
  const forumSourceIds = await bulkUpsertForumSourceRecords(
    plannedApplications.flatMap((planned) => planned.forumLinks)
  );
  const grants: GrantInput[] = [];
  const links: SourceLinkInput[] = [];
  const issues: ReconciliationIssueInput[] = [];
  counts.forumLinksCreatedOrUpdated = forumSourceIds.size;

  for (const planned of plannedApplications) {
    const applicationId = applicationIds.get(planned.application.canonicalKey);

    if (!applicationId) {
      throw new Error(`Failed to upsert grant application ${planned.application.canonicalKey}`);
    }

    for (const link of planned.links) {
      links.push({ ...link, canonicalId: applicationId });
    }

    for (const forumLink of planned.forumLinks) {
      const sourceRecordId = forumSourceIds.get(forumLink.url);

      if (sourceRecordId) {
        links.push({ sourceRecordId, canonicalId: applicationId, confidence: 1 });
      }
    }

    if (planned.grant) {
      grants.push({ ...planned.grant, applicationId });
    }

    for (const issue of planned.issues) {
      issues.push({ ...issue, canonicalId: applicationId });
    }
  }

  counts.grantsCreatedOrUpdated = await bulkUpsertGrants(grants);
  counts.linksCreated = await bulkLinkSources(links);
  counts.issuesCreated = await bulkCreateIssues(issues);

  await query(
    `insert into audit_events (action, target_type, metadata)
     values ('reconciliation.grants.completed', 'grant_application', $1::jsonb)`,
    [JSON.stringify(counts)]
  );

  return counts;
}
