import crypto from "node:crypto";
import { query } from "@/lib/db";

const generatedBy = "grant_knowledge_index_v1";
const contentMaxChars = 24000;
const sourceRecordBatchSize = 10;
const writeBatchSize = 15;

type GrantKnowledgeSourceRecord = {
  id: string;
  source_kind: string;
  source_id: string;
  source_url: string | null;
  title: string | null;
  summary: string | null;
  raw_payload: string | null;
  metadata: string | null;
};

type GrantKnowledgeApplicationRow = {
  id: string;
  canonical_key: string;
  title: string;
  applicant_name: string | null;
  normalized_status: string;
  requested_amount_usd: string | null;
  github_issue_number: string | null;
  github_issue_url: string | null;
  source_summary: string | null;
  github_labels: string | null;
  updated_at: string;
  sources: GrantKnowledgeSourceRecord[];
  decisionMentions: GrantKnowledgeDecisionMention[];
};

type GrantKnowledgeApplicationBaseRow = Omit<GrantKnowledgeApplicationRow, "sources" | "decisionMentions">;

type GrantKnowledgeDecisionMention = {
  id: string;
  source_record_id: string;
  meeting_date: string | null;
  meeting_title: string;
  topic_url: string;
  candidate_title: string;
  normalized_decision: string;
  decision_text: string | null;
  rationale_text: string | null;
  speaker_notes: string | null;
  match_method: string;
  confidence: string;
};

type KnowledgeDocumentInput = {
  documentKey: string;
  applicationId: string;
  sourceRecordId: string | null;
  documentKind: string;
  title: string;
  applicantName: string | null;
  sourceKind: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  normalizedStatus: string | null;
  requestedAmountUsd: string | null;
  content: string;
  contentHash: string;
  metadata: Record<string, unknown>;
};

export type GrantKnowledgeIndexResult = {
  ok: true;
  applicationsSeen: number;
  documentsIndexed: number;
  staleDocumentsRemoved: number;
};

function parseJsonRecord(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hashContent(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function collectStringValues(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    const text = compactWhitespace(value);
    return text ? [text] : [];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringValues(entry, depth + 1));
  }

  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => {
      const values = collectStringValues(entry, depth + 1);
      return values.map((entryValue) => `${key}: ${entryValue}`);
    });
  }

  return [];
}

function uniqueLines(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const text = typeof value === "string" ? compactWhitespace(value) : "";

    if (!text || seen.has(text)) {
      continue;
    }

    seen.add(text);
    output.push(text);
  }

  return output;
}

function truncateContent(value: string) {
  if (value.length <= contentMaxChars) {
    return value;
  }

  return `${value.slice(0, contentMaxChars - 120)}\n\n[Content truncated for retrieval index.]`;
}

function sourceLabel(source: GrantKnowledgeSourceRecord) {
  return `${source.source_kind}:${source.source_id}`;
}

function buildApplicationSummaryDocument(row: GrantKnowledgeApplicationRow): KnowledgeDocumentInput {
  const sourceSummary = parseJsonRecord(row.source_summary);
  const githubLabels = collectStringValues(JSON.parse(row.github_labels ?? "[]"));
  const lines = uniqueLines([
    `Grant application: ${row.title}`,
    row.applicant_name ? `Applicant: ${row.applicant_name}` : null,
    `Status: ${row.normalized_status}`,
    githubLabels.length ? `GitHub labels: ${githubLabels.join(" | ")}` : null,
    row.requested_amount_usd ? `Requested amount USD: ${row.requested_amount_usd}` : null,
    row.github_issue_number ? `GitHub issue: ${row.github_issue_number}` : null,
    row.github_issue_url ? `GitHub URL: ${row.github_issue_url}` : null,
    ...collectStringValues(sourceSummary)
  ]);
  const content = truncateContent(lines.join("\n"));

  return {
    documentKey: `application:${row.id}:summary`,
    applicationId: row.id,
    sourceRecordId: null,
    documentKind: "application_summary",
    title: row.title,
    applicantName: row.applicant_name,
    sourceKind: "canonical_application",
    sourceId: row.canonical_key,
    sourceUrl: row.github_issue_url,
    normalizedStatus: row.normalized_status,
    requestedAmountUsd: row.requested_amount_usd,
    content,
    contentHash: hashContent(content),
    metadata: {
      generatedBy,
      canonicalKey: row.canonical_key,
      updatedAt: row.updated_at
    }
  };
}

function buildSourceDocument(
  row: GrantKnowledgeApplicationRow,
  source: GrantKnowledgeSourceRecord
): KnowledgeDocumentInput {
  const raw = parseJsonRecord(source.raw_payload);
  const metadata = parseJsonRecord(source.metadata);
  const rawValues = source.source_kind === "forum_link"
    ? forumSourceValues(raw)
    : collectStringValues(raw);
  const lines = uniqueLines([
    `Grant application: ${row.title}`,
    row.applicant_name ? `Applicant: ${row.applicant_name}` : null,
    `Status: ${row.normalized_status}`,
    row.requested_amount_usd ? `Requested amount USD: ${row.requested_amount_usd}` : null,
    `Source: ${sourceLabel(source)}`,
    source.source_url ? `Source URL: ${source.source_url}` : null,
    source.title ? `Source title: ${source.title}` : null,
    source.summary ? `Source summary: ${source.summary}` : null,
    ...rawValues
  ]);
  const content = truncateContent(lines.join("\n"));

  return {
    documentKey: `application:${row.id}:source:${source.id}`,
    applicationId: row.id,
    sourceRecordId: source.id,
    documentKind: source.source_kind,
    title: source.title ?? row.title,
    applicantName: row.applicant_name,
    sourceKind: source.source_kind,
    sourceId: source.source_id,
    sourceUrl: source.source_url,
    normalizedStatus: row.normalized_status,
    requestedAmountUsd: row.requested_amount_usd,
    content,
    contentHash: hashContent(content),
    metadata: {
      generatedBy,
      sourceMetadata: metadata,
      canonicalKey: row.canonical_key
    }
  };
}

function buildDecisionDocument(
  row: GrantKnowledgeApplicationRow,
  mention: GrantKnowledgeDecisionMention
): KnowledgeDocumentInput {
  const speakerNotes = collectStringValues(JSON.parse(mention.speaker_notes ?? "[]"));
  const lines = uniqueLines([
    `Grant application: ${row.title}`,
    row.applicant_name ? `Applicant: ${row.applicant_name}` : null,
    `Status: ${row.normalized_status}`,
    `Decision evidence: ZCG meeting minutes`,
    mention.meeting_date ? `Meeting date: ${mention.meeting_date}` : null,
    `Meeting title: ${mention.meeting_title}`,
    `Referenced proposal: ${mention.candidate_title}`,
    `Normalized decision: ${mention.normalized_decision}`,
    mention.decision_text ? `Decision text: ${mention.decision_text}` : null,
    mention.rationale_text ? `Committee rationale: ${mention.rationale_text}` : null,
    speakerNotes.length ? `Committee notes: ${speakerNotes.join(" | ")}` : null,
    `Match method: ${mention.match_method}`,
    `Match confidence: ${mention.confidence}`,
    `Source URL: ${mention.topic_url}`
  ]);
  const content = truncateContent(lines.join("\n"));

  return {
    documentKey: `application:${row.id}:decision:${mention.id}`,
    applicationId: row.id,
    sourceRecordId: mention.source_record_id,
    documentKind: "decision_minutes",
    title: `${row.title} - decision minutes`,
    applicantName: row.applicant_name,
    sourceKind: "forum_meeting_minutes",
    sourceId: mention.topic_url,
    sourceUrl: mention.topic_url,
    normalizedStatus: row.normalized_status,
    requestedAmountUsd: row.requested_amount_usd,
    content,
    contentHash: hashContent(content),
    metadata: {
      generatedBy,
      decisionMentionId: mention.id,
      normalizedDecision: mention.normalized_decision,
      meetingDate: mention.meeting_date,
      canonicalKey: row.canonical_key
    }
  };
}

function forumSourceValues(raw: Record<string, unknown>) {
  const topic = raw.topic && typeof raw.topic === "object" && !Array.isArray(raw.topic)
    ? (raw.topic as Record<string, unknown>)
    : {};
  const posts = Array.isArray(raw.posts) ? raw.posts : [];
  const postTexts = posts
    .map((post) => {
      if (!post || typeof post !== "object" || Array.isArray(post)) {
        return null;
      }

      const record = post as Record<string, unknown>;
      const postNumber = record.postNumber ? `Post #${record.postNumber}` : "Forum post";
      const username = stringValue(record.username);
      const plainText = stringValue(record.plainText);

      return plainText ? `${postNumber}${username ? ` by ${username}` : ""}: ${plainText}` : null;
    })
    .filter((value): value is string => Boolean(value));
  const fullText = stringValue(raw.fullText);

  return uniqueLines([
    ...collectStringValues(topic),
    fullText,
    ...(fullText ? [] : postTexts)
  ]);
}

function documentsFromApplication(row: GrantKnowledgeApplicationRow): KnowledgeDocumentInput[] {
  return [
    buildApplicationSummaryDocument(row),
    ...row.sources.map((source) => buildSourceDocument(row, source)),
    ...row.decisionMentions.map((mention) => buildDecisionDocument(row, mention))
  ];
}

async function fetchApplicationRows() {
  const rows: GrantKnowledgeApplicationRow[] = [];
  let offset = 0;

  while (true) {
    const result = await query<GrantKnowledgeApplicationBaseRow>(
      `select ga.id::text,
              ga.canonical_key,
              ga.title,
              ga.applicant_name,
              ga.normalized_status,
              ga.requested_amount_usd::text,
              ga.github_issue_number::text,
              ga.github_issue_url,
              ga.source_summary::text,
              (
                select coalesce(
                  jsonb_agg(
                    jsonb_build_object(
                      'name', gal.label_name,
                      'category', gal.label_category,
                      'status', gal.label_status,
                      'milestoneNumber', gal.milestone_number
                    )
                    order by gal.label_order, gal.label_name
                  ),
                  '[]'::jsonb
                )::text
                  from grant_application_github_labels gal
                 where gal.application_id = ga.id
              ) as github_labels,
              ga.updated_at::text
         from grant_applications ga
        order by ga.updated_at desc, ga.id desc
        limit $1 offset $2`,
      [sourceRecordBatchSize, offset]
    );

    for (const row of result.rows) {
      const [sources, decisionMentions] = await Promise.all([
        fetchSourceRowsForApplication(row.id),
        fetchDecisionRowsForApplication(row.id)
      ]);

      rows.push({
        ...row,
        sources,
        decisionMentions
      });
    }

    if (result.rows.length < sourceRecordBatchSize) {
      break;
    }

    offset += sourceRecordBatchSize;
  }

  return rows;
}

async function fetchDecisionRowsForApplication(applicationId: string) {
  const result = await query<GrantKnowledgeDecisionMention>(
    `select gdm.id::text,
            gds.source_record_id::text,
            gds.meeting_date::text,
            gds.title as meeting_title,
            gds.topic_url,
            gdm.candidate_title,
            gdm.normalized_decision,
            gdm.decision_text,
            gdm.rationale_text,
            gdm.speaker_notes::text,
            gdm.match_method,
            gdm.confidence::text
       from grant_decision_mentions gdm
       join grant_decision_sources gds on gds.id = gdm.decision_source_id
      where gdm.application_id = $1
        and gdm.review_status = 'accepted'
      order by gds.meeting_date desc nulls last, gdm.updated_at desc`,
    [applicationId]
  );

  return result.rows;
}

async function fetchSourceRowsForApplication(applicationId: string) {
  const rows: GrantKnowledgeSourceRecord[] = [];
  let offset = 0;

  while (true) {
    const result = await query<GrantKnowledgeSourceRecord>(
      `select sr.id::text,
              sr.source_kind,
              sr.source_id,
              sr.source_url,
              sr.title,
              sr.summary,
              case
                when sr.source_kind = 'forum_link'
                  and sr.metadata->>'mirrorKind' = 'forum_topic'
                  then jsonb_build_object(
                    'url', sr.raw_payload->'url',
                    'jsonUrl', sr.raw_payload->'jsonUrl',
                    'topic', sr.raw_payload->'topic',
                    'fullText', left(coalesce(sr.raw_payload->>'fullText', ''), $4::integer)
                  )::text
                else sr.raw_payload::text
              end as raw_payload,
              sr.metadata::text
         from source_links sl
         join source_records sr on sr.id = sl.source_record_id
        where sl.canonical_type = 'grant_application'
          and sl.canonical_id = $1
        order by sr.source_kind, sr.source_id
        limit $2 offset $3`,
      [applicationId, sourceRecordBatchSize, offset, contentMaxChars]
    );

    rows.push(...result.rows);

    if (result.rows.length < sourceRecordBatchSize) {
      break;
    }

    offset += sourceRecordBatchSize;
  }

  return rows;
}

async function upsertKnowledgeDocuments(documents: KnowledgeDocumentInput[]) {
  for (const batch of chunkArray(documents, writeBatchSize)) {
    const payload = batch.map((document) => ({
      document_key: document.documentKey,
      application_id: document.applicationId,
      source_record_id: document.sourceRecordId,
      document_kind: document.documentKind,
      title: document.title,
      applicant_name: document.applicantName,
      source_kind: document.sourceKind,
      source_id: document.sourceId,
      source_url: document.sourceUrl,
      normalized_status: document.normalizedStatus,
      requested_amount_usd: document.requestedAmountUsd,
      content: document.content,
      content_hash: document.contentHash,
      metadata: document.metadata
    }));

    await query(
      `insert into grant_knowledge_documents (
         document_key,
         application_id,
         source_record_id,
         document_kind,
         title,
         applicant_name,
         source_kind,
         source_id,
         source_url,
         normalized_status,
         requested_amount_usd,
         content,
         content_hash,
         metadata,
         indexed_at,
         updated_at
       )
       select document_key,
              application_id,
              source_record_id,
              document_kind,
              title,
              applicant_name,
              source_kind,
              source_id,
              source_url,
              normalized_status,
              requested_amount_usd,
              content,
              content_hash,
              coalesce(metadata, '{}'::jsonb),
              now(),
              now()
         from jsonb_to_recordset($1::jsonb) as x(
           document_key text,
           application_id uuid,
           source_record_id uuid,
           document_kind text,
           title text,
           applicant_name text,
           source_kind text,
           source_id text,
           source_url text,
           normalized_status text,
           requested_amount_usd numeric,
           content text,
           content_hash text,
           metadata jsonb
         )
       on conflict (document_key)
       do update set application_id = excluded.application_id,
                     source_record_id = excluded.source_record_id,
                     document_kind = excluded.document_kind,
                     title = excluded.title,
                     applicant_name = excluded.applicant_name,
                     source_kind = excluded.source_kind,
                     source_id = excluded.source_id,
                     source_url = excluded.source_url,
                     normalized_status = excluded.normalized_status,
                     requested_amount_usd = excluded.requested_amount_usd,
                     content = excluded.content,
                     content_hash = excluded.content_hash,
                     metadata = excluded.metadata,
                     indexed_at = now(),
                     updated_at = now()`,
      [JSON.stringify(payload)]
    );
  }
}

async function deleteStaleDocuments(documentKeys: string[]) {
  if (!documentKeys.length) {
    const result = await query(
      `delete from grant_knowledge_documents
        where metadata->>'generatedBy' = $1`,
      [generatedBy]
    );

    return result.rowCount ?? 0;
  }

  const result = await query(
    `delete from grant_knowledge_documents
      where metadata->>'generatedBy' = $1
        and document_key not in (
          select value
            from jsonb_array_elements_text($2::jsonb) as retained(value)
        )`,
    [generatedBy, JSON.stringify(documentKeys)]
  );

  return result.rowCount ?? 0;
}

export async function refreshGrantKnowledgeDocuments(): Promise<GrantKnowledgeIndexResult> {
  const applications = await fetchApplicationRows();
  const documents = [
    ...new Map(
      applications
        .flatMap((application) => documentsFromApplication(application))
        .map((document) => [document.documentKey, document])
    ).values()
  ];

  await upsertKnowledgeDocuments(documents);
  const staleDocumentsRemoved = await deleteStaleDocuments(documents.map((document) => document.documentKey));

  return {
    ok: true,
    applicationsSeen: applications.length,
    documentsIndexed: documents.length,
    staleDocumentsRemoved
  };
}
