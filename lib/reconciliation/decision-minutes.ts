import crypto from "node:crypto";
import { query } from "@/lib/db";

const generatedBy = "grant_decision_minutes_v1";
const parserVersion = "zcg_minutes_parser_v1";
const sourceRecordBatchSize = 20;
const maxRationaleLength = 12000;

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

type GrantApplicationIndexRow = {
  id: string;
  canonical_key: string;
  title: string;
  normalized_status: string;
  github_issue_number: string | null;
  github_issue_url: string | null;
};

type SourceLinkIndexRow = {
  application_id: string;
  canonical_key: string;
  title: string;
  normalized_status: string;
  source_record_id: string;
  source_kind: string;
  source_id: string;
  source_url: string | null;
  confidence: string;
};

type DecisionSourceInput = {
  sourceRecordId: string;
  forumTopicId: number | null;
  topicUrl: string;
  title: string;
  meetingDate: string | null;
  contentHash: string;
  metadata: Record<string, unknown>;
};

type ParsedDecisionMention = {
  mentionKey: string;
  linkedSourceUrl: string | null;
  candidateTitle: string;
  normalizedDecision: string;
  decisionText: string | null;
  rationaleText: string | null;
  speakerNotes: Array<{ speaker: string; note: string }>;
  contentHash: string;
  metadata: Record<string, unknown>;
};

type MatchedDecisionMention = ParsedDecisionMention & {
  applicationId: string | null;
  linkedSourceRecordId: string | null;
  matchMethod: string;
  confidence: number;
  reviewStatus: "accepted" | "needs_review";
};

export type GrantDecisionMinutesResult = {
  sourcesParsed: number;
  mentionsParsed: number;
  mentionsLinked: number;
  mentionsNeedingReview: number;
  issuesCreated: number;
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

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hashContent(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeTitle(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/^zcg\s+application\s+draft\s+(?:\u2014|-)\s*/i, "")
    .replace(/^grant\s+application\s+(?:\u2014|-|:)\s*/i, "")
    .replace(/^grant\s+application\s+/i, "")
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

function normalizeUrl(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/g, "");
    return parsed.toString();
  } catch {
    return value.replace(/[.,;:]+$/g, "").replace(/\/+$/g, "") || null;
  }
}

function isForumTopicUrl(value: string | null | undefined) {
  const normalized = normalizeUrl(value);

  if (!normalized) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    return parsed.hostname === "forum.zcashcommunity.com" && parsed.pathname.startsWith("/t/");
  } catch {
    return false;
  }
}

function indexOfInsensitive(haystack: string, needle: string, fromIndex = 0) {
  return haystack.toLowerCase().indexOf(needle.toLowerCase(), fromIndex);
}

function textAfterHeading(text: string, heading: string) {
  const index = indexOfInsensitive(text, heading);
  return index >= 0 ? text.slice(index + heading.length) : "";
}

function textBetweenHeadings(text: string, startHeading: string, endHeading: string) {
  const startIndex = indexOfInsensitive(text, startHeading);

  if (startIndex < 0) {
    return "";
  }

  const contentStart = startIndex + startHeading.length;
  const endIndex = indexOfInsensitive(text, endHeading, contentStart);
  return endIndex >= 0 ? text.slice(contentStart, endIndex) : text.slice(contentStart);
}

function titleSections(sectionText: string, titles: string[]) {
  const found = titles
    .map((title) => ({ title, index: indexOfInsensitive(sectionText, title) }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index);
  const sections = new Map<string, string>();

  for (const [index, entry] of found.entries()) {
    const next = found[index + 1];
    const section = sectionText.slice(entry.index, next ? next.index : undefined).trim();
    sections.set(entry.title, section);
  }

  return sections;
}

function normalizeDecisionLine(value: string) {
  const normalized = value.toLowerCase().replace(/\basnyc\b/g, "async");

  if (/\bremains?\s+open\b/.test(normalized) || /\bstill\s+open\b/.test(normalized)) {
    return { decision: "remains_open", text: value };
  }

  if (/\bdefer(?:red)?\b/.test(normalized) || /\bpostpone(?:d)?\b/.test(normalized)) {
    return { decision: "deferred", text: value };
  }

  if (/\bdeclin(?:e|ed)\b/.test(normalized) || /\breject(?:ed)?\b/.test(normalized)) {
    return { decision: "declined", text: value };
  }

  if (/\bwithdrawn\b/.test(normalized)) {
    return { decision: "withdrawn", text: value };
  }

  if (/\bcancel(?:led|ed)\b/.test(normalized)) {
    return { decision: "cancelled", text: value };
  }

  if (/\bapproved?\b/.test(normalized)) {
    return {
      decision: normalized.includes("async") ? "approved_async" : "approved",
      text: value
    };
  }

  return null;
}

function extractDecision(section: string | null | undefined) {
  if (!section) {
    return { decision: "unknown", text: null as string | null };
  }

  const lines = section
    .split(/\n+/)
    .map((line) => compactWhitespace(line))
    .filter(Boolean);

  for (const line of [...lines].reverse()) {
    const normalized = normalizeDecisionLine(line);

    if (normalized) {
      return normalized;
    }
  }

  return { decision: "unknown", text: null as string | null };
}

function extractSpeakerNotes(section: string | null | undefined) {
  if (!section) {
    return [];
  }

  return section
    .split(/\n+/)
    .map((line) => compactWhitespace(line))
    .map((line) => {
      const match = line.match(/^([A-Z][A-Za-z0-9 ._-]{1,36}):\s+(.+)$/);
      return match ? { speaker: match[1].trim(), note: match[2].trim() } : null;
    })
    .filter((entry): entry is { speaker: string; note: string } => Boolean(entry));
}

function trimRationale(section: string | null | undefined, title: string, decisionText: string | null) {
  if (!section) {
    return null;
  }

  let rationale = section.trim();

  if (rationale.toLowerCase().startsWith(title.toLowerCase())) {
    rationale = rationale.slice(title.length).trim();
  }

  if (decisionText) {
    const decisionIndex = rationale.toLowerCase().lastIndexOf(decisionText.toLowerCase());

    if (decisionIndex >= 0 && decisionIndex > rationale.length - decisionText.length - 200) {
      rationale = rationale.slice(0, decisionIndex).trim();
    }
  }

  rationale = rationale.replace(/\n{3,}/g, "\n\n").trim();

  if (!rationale) {
    return null;
  }

  return rationale.length > maxRationaleLength
    ? `${rationale.slice(0, maxRationaleLength - 80)}\n\n[Decision rationale truncated.]`
    : rationale;
}

function extractMeetingDate(title: string | null, plainText: string) {
  const combined = `${title ?? ""}\n${plainText}`;
  const longDate = combined.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i);

  if (longDate) {
    const parsed = new Date(longDate[0]);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  }

  const numeric = combined.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);

  if (!numeric) {
    return null;
  }

  const month = Number(numeric[1]);
  const day = Number(numeric[2]);
  const yearValue = Number(numeric[3]);
  const year = yearValue < 100 ? 2000 + yearValue : yearValue;

  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000) {
    return null;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function mentionKey(sourceRecordId: string, linkedSourceUrl: string | null, candidateTitle: string) {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify({ sourceRecordId, linkedSourceUrl, candidateTitle: normalizeTitle(candidateTitle) }))
    .digest("hex")
    .slice(0, 32);

  return `decision_minutes:${digest}`;
}

function linksFromRawPayload(raw: Record<string, unknown>) {
  const posts = Array.isArray(raw.posts) ? raw.posts : [];
  const firstPost = posts[0] && typeof posts[0] === "object" && !Array.isArray(posts[0])
    ? (posts[0] as Record<string, unknown>)
    : {};
  const links = Array.isArray(firstPost.links) ? firstPost.links : [];

  return links
    .map((link) => {
      if (!link || typeof link !== "object" || Array.isArray(link)) {
        return null;
      }

      const record = link as Record<string, unknown>;
      const url = normalizeUrl(stringValue(record.normalizedUrl) ?? stringValue(record.href));
      const text = stringValue(record.text);

      return url && text && isForumTopicUrl(url)
        ? { url, title: text }
        : null;
    })
    .filter((entry): entry is { url: string; title: string } => Boolean(entry));
}

function plainTextFromRawPayload(raw: Record<string, unknown>) {
  const fullText = stringValue(raw.fullText);

  if (fullText) {
    return fullText;
  }

  const posts = Array.isArray(raw.posts) ? raw.posts : [];
  return posts
    .map((post) => {
      if (!post || typeof post !== "object" || Array.isArray(post)) {
        return null;
      }

      return stringValue((post as Record<string, unknown>).plainText);
    })
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}

function decisionSourceFromRecord(record: RawSourceRecord): DecisionSourceInput | null {
  const raw = parseJsonRecord(record.raw_payload);
  const metadata = parseJsonRecord(record.metadata);
  const topic = raw.topic && typeof raw.topic === "object" && !Array.isArray(raw.topic)
    ? (raw.topic as Record<string, unknown>)
    : {};
  const plainText = plainTextFromRawPayload(raw);
  const topicId = numberValue(metadata.topicId) ?? numberValue(topic.id);
  const topicUrl = record.source_url ?? record.source_id;
  const title = record.title ?? stringValue(topic.title) ?? `Forum topic ${topicId ?? topicUrl}`;

  if (!topicUrl || !plainText.toLowerCase().includes("meeting")) {
    return null;
  }

  return {
    sourceRecordId: record.id,
    forumTopicId: topicId,
    topicUrl,
    title,
    meetingDate: extractMeetingDate(title, plainText),
    contentHash: hashContent({ topicUrl, title, plainText }),
    metadata: {
      generatedBy,
      parserVersion,
      sourceKind: record.source_kind,
      sourceId: record.source_id,
      sourceUpdatedAt: record.source_updated_at,
      sourceMetadata: metadata
    }
  };
}

function decisionMentionsFromRecord(record: RawSourceRecord) {
  const raw = parseJsonRecord(record.raw_payload);
  const source = decisionSourceFromRecord(record);

  if (!source) {
    return { source: null, mentions: [] as ParsedDecisionMention[] };
  }

  const plainText = plainTextFromRawPayload(raw);
  const sourceUrl = normalizeUrl(record.source_url ?? record.source_id);
  const links = linksFromRawPayload(raw)
    .filter((link) => normalizeUrl(link.url) !== sourceUrl);
  const uniqueLinks = new Map<string, { url: string; title: string }>();

  for (const link of links) {
    if (!uniqueLinks.has(link.url)) {
      uniqueLinks.set(link.url, link);
    }
  }

  const grantLinks = [...uniqueLinks.values()];
  const titles = grantLinks.map((link) => link.title);
  const keyTakeaways = textBetweenHeadings(plainText, "Key Takeaways", "Open Grant Proposals");
  const detailedText = textAfterHeading(plainText, "Open Grant Proposals");
  const keySections = titleSections(keyTakeaways, titles);
  const detailedSections = titleSections(detailedText, titles);
  const mentions = grantLinks
    .map((link) => {
      const keySection = keySections.get(link.title) ?? null;
      const detailSection = detailedSections.get(link.title) ?? null;
      const decision = extractDecision(keySection ?? detailSection);
      const rationaleText = trimRationale(detailSection, link.title, decision.text);
      const speakerNotes = extractSpeakerNotes(detailSection);
      const linkedSourceUrl = normalizeUrl(link.url);
      const contentHash = hashContent({
        sourceRecordId: record.id,
        linkedSourceUrl,
        candidateTitle: link.title,
        decision,
        rationaleText,
        speakerNotes
      });

      return {
        mentionKey: mentionKey(record.id, linkedSourceUrl, link.title),
        linkedSourceUrl,
        candidateTitle: link.title,
        normalizedDecision: decision.decision,
        decisionText: decision.text,
        rationaleText,
        speakerNotes,
        contentHash,
        metadata: {
          generatedBy,
          parserVersion,
          keyTakeawayExcerpt: keySection,
          hasDetailedRationale: Boolean(rationaleText),
          sourceRecordId: record.id
        }
      };
    })
    .filter((mention) => mention.normalizedDecision !== "unknown" || mention.rationaleText);

  return { source, mentions };
}

async function fetchDecisionMinuteRecords() {
  const records: RawSourceRecord[] = [];
  let offset = 0;

  while (true) {
    const result = await query<RawSourceRecord>(
      `select id::text,
              source_kind,
              source_id,
              source_url,
              title,
              summary,
              source_updated_at::text,
              raw_payload::text,
              metadata::text
         from source_records
        where source_kind = 'forum_meeting_minutes'
        order by source_updated_at desc nulls last, source_id
        limit $1 offset $2`,
      [sourceRecordBatchSize, offset]
    );

    records.push(...result.rows);

    if (result.rows.length < sourceRecordBatchSize) {
      break;
    }

    offset += sourceRecordBatchSize;
  }

  return records;
}

async function fetchApplications() {
  const result = await query<GrantApplicationIndexRow>(
    `select id::text,
            canonical_key,
            title,
            normalized_status,
            github_issue_number::text,
            github_issue_url
       from grant_applications`
  );

  return result.rows;
}

async function fetchSourceLinkIndex() {
  const result = await query<SourceLinkIndexRow>(
    `select ga.id::text as application_id,
            ga.canonical_key,
            ga.title,
            ga.normalized_status,
            sr.id::text as source_record_id,
            sr.source_kind,
            sr.source_id,
            sr.source_url,
            sl.confidence::text
       from source_links sl
       join source_records sr on sr.id = sl.source_record_id
       join grant_applications ga on ga.id = sl.canonical_id
      where sl.canonical_type = 'grant_application'`
  );

  return result.rows;
}

function buildDirectMatchIndex(sourceLinks: SourceLinkIndexRow[], applications: GrantApplicationIndexRow[]) {
  const byUrl = new Map<string, SourceLinkIndexRow>();

  function add(url: string | null | undefined, row: SourceLinkIndexRow) {
    const normalized = normalizeUrl(url);

    if (!normalized) {
      return;
    }

    const existing = byUrl.get(normalized);

    if (!existing || Number(row.confidence) > Number(existing.confidence)) {
      byUrl.set(normalized, row);
    }
  }

  for (const row of sourceLinks) {
    add(row.source_url, row);
    add(row.source_id, row);
  }

  for (const application of applications) {
    const githubIssueUrl = normalizeUrl(application.github_issue_url);

    if (githubIssueUrl) {
      byUrl.set(githubIssueUrl, {
        application_id: application.id,
        canonical_key: application.canonical_key,
        title: application.title,
        normalized_status: application.normalized_status,
        source_record_id: "",
        source_kind: "grant_application",
        source_id: application.canonical_key,
        source_url: application.github_issue_url,
        confidence: "1"
      });
    }
  }

  return byUrl;
}

function bestTitleMatch(mention: ParsedDecisionMention, applications: GrantApplicationIndexRow[]) {
  let best: { application: GrantApplicationIndexRow; confidence: number } | null = null;

  for (const application of applications) {
    const confidence = jaccard(mention.candidateTitle, application.title);

    if (!best || confidence > best.confidence) {
      best = { application, confidence };
    }
  }

  return best && best.confidence >= 0.86 ? best : null;
}

function matchMention(
  mention: ParsedDecisionMention,
  directIndex: Map<string, SourceLinkIndexRow>,
  applications: GrantApplicationIndexRow[]
): MatchedDecisionMention {
  const direct = mention.linkedSourceUrl ? directIndex.get(mention.linkedSourceUrl) : null;

  if (direct) {
    return {
      ...mention,
      applicationId: direct.application_id,
      linkedSourceRecordId: direct.source_record_id || null,
      matchMethod: direct.source_kind === "grant_application" ? "github_issue_url" : "direct_source_url",
      confidence: 1,
      reviewStatus: "accepted"
    };
  }

  const titleMatch = bestTitleMatch(mention, applications);

  if (titleMatch) {
    return {
      ...mention,
      applicationId: titleMatch.application.id,
      linkedSourceRecordId: null,
      matchMethod: "title_similarity",
      confidence: titleMatch.confidence,
      reviewStatus: "accepted"
    };
  }

  return {
    ...mention,
    applicationId: null,
    linkedSourceRecordId: null,
    matchMethod: "unmatched",
    confidence: 0,
    reviewStatus: "needs_review"
  };
}

async function upsertDecisionSource(input: DecisionSourceInput) {
  const result = await query<{ id: string }>(
    `insert into grant_decision_sources (
       source_record_id,
       forum_topic_id,
       topic_url,
       title,
       meeting_date,
       parser_version,
       content_hash,
       metadata,
       updated_at
     )
     values ($1, $2, $3, $4, $5::date, $6, $7, $8::jsonb, now())
     on conflict (source_record_id)
     do update set forum_topic_id = excluded.forum_topic_id,
                   topic_url = excluded.topic_url,
                   title = excluded.title,
                   meeting_date = excluded.meeting_date,
                   parser_version = excluded.parser_version,
                   content_hash = excluded.content_hash,
                   metadata = excluded.metadata,
                   updated_at = now()
     returning id::text`,
    [
      input.sourceRecordId,
      input.forumTopicId,
      input.topicUrl,
      input.title,
      input.meetingDate,
      parserVersion,
      input.contentHash,
      JSON.stringify(input.metadata)
    ]
  );

  return result.rows[0]?.id ?? null;
}

async function markExistingMentionsStale(decisionSourceId: string) {
  await query(
    `update grant_decision_mentions
        set review_status = 'stale',
            updated_at = now()
      where decision_source_id = $1
        and metadata->>'generatedBy' = $2`,
    [decisionSourceId, generatedBy]
  );
}

async function upsertDecisionMention(decisionSourceId: string, mention: MatchedDecisionMention) {
  const result = await query<{ id: string }>(
    `insert into grant_decision_mentions (
       mention_key,
       decision_source_id,
       application_id,
       linked_source_record_id,
       linked_source_url,
       candidate_title,
       normalized_decision,
       decision_text,
       rationale_text,
       speaker_notes,
       match_method,
       confidence,
       review_status,
       content_hash,
       metadata,
       updated_at
     )
     values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10::jsonb, $11, $12, $13, $14, $15::jsonb, now()
     )
     on conflict (mention_key)
     do update set decision_source_id = excluded.decision_source_id,
                   application_id = excluded.application_id,
                   linked_source_record_id = excluded.linked_source_record_id,
                   linked_source_url = excluded.linked_source_url,
                   candidate_title = excluded.candidate_title,
                   normalized_decision = excluded.normalized_decision,
                   decision_text = excluded.decision_text,
                   rationale_text = excluded.rationale_text,
                   speaker_notes = excluded.speaker_notes,
                   match_method = excluded.match_method,
                   confidence = excluded.confidence,
                   review_status = excluded.review_status,
                   content_hash = excluded.content_hash,
                   metadata = excluded.metadata,
                   updated_at = now()
     returning id::text`,
    [
      mention.mentionKey,
      decisionSourceId,
      mention.applicationId,
      mention.linkedSourceRecordId,
      mention.linkedSourceUrl,
      mention.candidateTitle,
      mention.normalizedDecision,
      mention.decisionText,
      mention.rationaleText,
      JSON.stringify(mention.speakerNotes),
      mention.matchMethod,
      mention.confidence,
      mention.reviewStatus,
      mention.contentHash,
      JSON.stringify(mention.metadata)
    ]
  );

  return result.rows[0]?.id ?? null;
}

async function linkDecisionSourceToApplication(sourceRecordId: string, applicationId: string, confidence: number) {
  await query(
    `insert into source_links (source_record_id, canonical_type, canonical_id, confidence, relationship_role)
     values ($1, 'grant_application', $2, $3, 'decision_minutes')
     on conflict (source_record_id, canonical_type, canonical_id)
     do update set confidence = greatest(source_links.confidence, excluded.confidence),
                   relationship_role = 'decision_minutes'`,
    [sourceRecordId, applicationId, confidence]
  );
}

function terminalDecisionConflict(decision: string, applicationStatus: string | null | undefined) {
  const status = applicationStatus ?? "unknown";

  if (decision === "approved" || decision === "approved_async") {
    return !["approved", "active", "completed"].includes(status);
  }

  if (decision === "declined") {
    return status !== "declined";
  }

  if (decision === "withdrawn") {
    return status !== "withdrawn";
  }

  if (decision === "cancelled") {
    return status !== "cancelled";
  }

  return false;
}

async function deleteOpenGeneratedIssues() {
  await query(
    `delete from reconciliation_issues
      where details->>'generatedBy' = $1
        and status = 'open'`,
    [generatedBy]
  );
}

async function createIssue(input: {
  issueType: string;
  severity: "info" | "warning" | "error";
  sourceRecordId: string | null;
  applicationId: string | null;
  summary: string;
  details: Record<string, unknown>;
}) {
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
     values ($1, $2, $3, 'grant_application', $4, $5, $6::jsonb)`,
    [
      input.issueType,
      input.severity,
      input.sourceRecordId,
      input.applicationId,
      input.summary,
      JSON.stringify({ generatedBy, ...input.details })
    ]
  );
}

export async function reconcileGrantDecisionMinutes(): Promise<GrantDecisionMinutesResult> {
  const records = await fetchDecisionMinuteRecords();
  const applications = await fetchApplications();
  const sourceLinks = await fetchSourceLinkIndex();
  const directIndex = buildDirectMatchIndex(sourceLinks, applications);
  const applicationsById = new Map(applications.map((application) => [application.id, application]));
  const result: GrantDecisionMinutesResult = {
    sourcesParsed: 0,
    mentionsParsed: 0,
    mentionsLinked: 0,
    mentionsNeedingReview: 0,
    issuesCreated: 0
  };

  await deleteOpenGeneratedIssues();

  for (const record of records) {
    const { source, mentions } = decisionMentionsFromRecord(record);

    if (!source) {
      continue;
    }

    const decisionSourceId = await upsertDecisionSource(source);

    if (!decisionSourceId) {
      continue;
    }

    await markExistingMentionsStale(decisionSourceId);
    result.sourcesParsed += 1;
    result.mentionsParsed += mentions.length;

    for (const mention of mentions) {
      const matched = matchMention(mention, directIndex, applications);
      const mentionId = await upsertDecisionMention(decisionSourceId, matched);

      if (matched.applicationId) {
        await linkDecisionSourceToApplication(record.id, matched.applicationId, matched.confidence);
        result.mentionsLinked += 1;

        const application = applicationsById.get(matched.applicationId);

        if (application && terminalDecisionConflict(matched.normalizedDecision, application.normalized_status)) {
          await createIssue({
            issueType: "decision_status_conflict",
            severity: "warning",
            sourceRecordId: record.id,
            applicationId: matched.applicationId,
            summary: `Meeting minutes decision conflicts with canonical status for ${application.title}`,
            details: {
              mentionId,
              meetingTitle: source.title,
              meetingDate: source.meetingDate,
              candidateTitle: matched.candidateTitle,
              linkedSourceUrl: matched.linkedSourceUrl,
              normalizedDecision: matched.normalizedDecision,
              canonicalStatus: application.normalized_status,
              matchMethod: matched.matchMethod,
              confidence: matched.confidence
            }
          });
          result.issuesCreated += 1;
        }

        continue;
      }

      result.mentionsNeedingReview += 1;
      await createIssue({
        issueType: "unlinked_decision_minutes",
        severity: "warning",
        sourceRecordId: record.id,
        applicationId: null,
        summary: `Meeting minutes mention is not linked to a canonical application: ${matched.candidateTitle}`,
        details: {
          mentionId,
          meetingTitle: source.title,
          meetingDate: source.meetingDate,
          candidateTitle: matched.candidateTitle,
          linkedSourceUrl: matched.linkedSourceUrl,
          normalizedDecision: matched.normalizedDecision,
          decisionText: matched.decisionText,
          matchMethod: matched.matchMethod,
          confidence: matched.confidence
        }
      });
      result.issuesCreated += 1;
    }
  }

  return result;
}
