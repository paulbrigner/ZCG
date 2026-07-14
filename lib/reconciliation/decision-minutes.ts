import crypto from "node:crypto";
import { query } from "@/lib/db";

const generatedBy = "grant_decision_minutes_v1";
const parserVersion = "zcg_minutes_parser_v2";
const sourceRecordBatchSize = 20;
const maxRationaleLength = 12000;

type RawSourceRecord = {
  id: string;
  source_kind: string;
  source_id: string;
  source_url: string | null;
  checksum_sha256?: string | null;
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
  relationship_role: string;
};

type DirectMatchIndexes = {
  byUrl: Map<string, SourceLinkIndexRow>;
  ambiguousUrls: Set<string>;
  byPrimaryForumTopicId: Map<string, SourceLinkIndexRow>;
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

type LinkedMentionForReview = {
  application: GrantApplicationIndexRow;
  matched: MatchedDecisionMention;
  mentionId: string;
  source: DecisionSourceInput;
  sourceUpdatedAt: string | null;
  sourceRecordId: string;
};

export type GrantDecisionMinutesResult = {
  sourcesParsed: number;
  mentionsParsed: number;
  mentionsLinked: number;
  mentionsNeedingReview: number;
  issuesCreated: number;
};

export type GrantDecisionMinutesContext = {
  syncRunId?: string | null;
  reconciliationRunId?: string | null;
  observedAt?: string | null;
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

function lineEntries(text: string) {
  const entries: Array<{ text: string; start: number; end: number }> = [];
  let offset = 0;

  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();

    if (trimmed) {
      const leadingWhitespace = rawLine.length - rawLine.trimStart().length;
      entries.push({
        text: trimmed,
        start: offset + leadingWhitespace,
        end: offset + rawLine.length
      });
    }

    offset += rawLine.length + 1;
  }

  return entries;
}

function isAnchoredTitleLine(line: string, title: string) {
  const normalizedLine = normalizeTitle(line);
  const normalizedCandidate = normalizeTitle(title);

  if (!normalizedCandidate || !normalizedLine.startsWith(normalizedCandidate)) {
    return false;
  }

  if (normalizedLine === normalizedCandidate) {
    return true;
  }

  return normalizedLine.startsWith(`${normalizedCandidate} `);
}

function titleSections(sectionText: string, titles: string[]) {
  const normalizedTitles = [...titles].sort(
    (left, right) => normalizeTitle(right).length - normalizeTitle(left).length
  );
  const found: Array<{ title: string; index: number }> = [];
  const seenTitles = new Set<string>();

  for (const line of lineEntries(sectionText)) {
    const title = normalizedTitles.find((candidate) => isAnchoredTitleLine(line.text, candidate));

    if (!title || seenTitles.has(title)) {
      continue;
    }

    seenTitles.add(title);
    found.push({ title, index: line.start });
  }

  found.sort((left, right) => left.index - right.index);
  const sections = new Map<string, string>();

  for (const [index, entry] of found.entries()) {
    const next = found[index + 1];
    const section = sectionText.slice(entry.index, next ? next.index : undefined).trim();
    sections.set(entry.title, section);
  }

  return sections;
}

function normalizeDecisionLine(value: string) {
  const normalized = compactWhitespace(value).toLowerCase().replace(/\basnyc\b/g, "async");

  if (/^(?:approve|decline|reject|abstain)\s*:/.test(normalized)) {
    return null;
  }

  const approvedTally = normalized.match(/\bapprove(?:d)?\s+(\d+)\b/);
  const declinedTally = normalized.match(/\b(?:decline(?:d)?|reject(?:ed)?)\s+(\d+)\b/);

  if (approvedTally && declinedTally) {
    const approvedVotes = Number(approvedTally[1]);
    const declinedVotes = Number(declinedTally[1]);

    if (approvedVotes === declinedVotes) {
      return null;
    }

    return {
      decision: approvedVotes > declinedVotes ? "approved" : "declined",
      text: value
    };
  }

  if (
    /\bmilestone\b.*\bapproved?\b.*\b(?:remainder|rest)\b.*\b(?:reject(?:ed)?|declin(?:e|ed))\b/.test(
      normalized
    )
  ) {
    return { decision: "partial_approval", text: value };
  }

  if (
    /\b(?:will|would|may|might)\s+(?:not\s+)?be\s+cancel(?:led|ed)\b/.test(normalized) ||
    /\bcancel(?:ling|ing)\s+is\s+possible\b/.test(normalized)
  ) {
    return null;
  }

  if (
    /\bnot\s+(?:approve(?:d)?|declin(?:e|ed)|reject(?:ed)?)\b.*\b(?:unless|until|without|but)\b/.test(
      normalized
    )
  ) {
    return null;
  }

  if (/\bnot\s+(?:yet\s+)?approved?\b/.test(normalized)) {
    return {
      decision: /\b(?:yet|pending|too early|will vote|wait(?:ing)?)\b/.test(normalized)
        ? "remains_open"
        : "declined",
      text: value
    };
  }

  if (/\b(?:should have been|was|is|has been)\s+filtered\b/.test(normalized)) {
    return { decision: "filtered", text: value };
  }

  if (
    /\bremains?\s+open\b/.test(normalized) ||
    /\bstill\s+open\b/.test(normalized) ||
    /\b(?:leave|keep)\s+(?:it|this|the (?:grant|proposal|application))\s+open\b/.test(normalized) ||
    /\btoo\s+early\s+(?:for\s+the\s+committee\s+)?to\s+vote\b/.test(normalized) ||
    /\bwill\s+vote\b.*\bnext\s+meeting\b/.test(normalized) ||
    /\b(?:need|needs|needed)\b.*\b(?:input|information|feedback|research)\b.*\b(?:make|making)\s+a\s+decision\b/.test(
      normalized
    ) ||
    /\b(?:no|not)\s+(?:final\s+)?decision\b/.test(normalized) ||
    /\bhold\s+off\b/.test(normalized)
  ) {
    return { decision: "remains_open", text: value };
  }

  if (/\bdefer(?:red)?\b/.test(normalized) || /\bpostpone(?:d)?\b/.test(normalized)) {
    return { decision: "deferred", text: value };
  }

  if (
    /\b(?:ask(?:ed|ing)?|question(?:ed|ing)?|consider(?:ed|ing)?|whether|if)\b.*\b(?:declin(?:e|ed)|reject(?:ed)?)\b/.test(
      normalized
    ) ||
    /\b(?:do\s+not|don't|should\s+not|shouldn't)\s+(?:decline|reject)\b/.test(normalized)
  ) {
    return null;
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

  if (
    /^(?:the\s+)?(?:(?:grant|proposal|application|request|milestone(?:\s+\d+)?)\s+)?approved?(?:\s+async)?[.!]?$/i.test(
      normalized
    ) ||
    /\b(?:zcg|committee|members?|majority|we|they)\b.{0,100}\b(?:voted?\s+to\s+approve|unanimously\s+approved|approved)\b/.test(
      normalized
    ) ||
    /\b(?:grant|proposal|application|request|milestone(?:\s+\d+)?)\b.{0,40}\b(?:was|is|has been|were)\s+(?:unanimously\s+)?approved\b/.test(
      normalized
    ) ||
    /\bapproved\s+(?:this|the)\s+(?:grant|proposal|application|request|milestone)\b/.test(normalized) ||
    /\bapproved\s+via\s+(?:signal|mobile|email|vote)\b/.test(normalized)
  ) {
    return {
      decision: normalized.includes("async") ? "approved_async" : "approved",
      text: value
    };
  }

  return null;
}

function incompleteDecisionFragment(value: string) {
  const normalized = value.toLowerCase().replace(/[\s.,;:!?-]+$/g, "");
  return /\b(?:approve(?:d)?|declin(?:e|ed)|reject(?:ed)?)\s+(?:the|a|an|this|that|to)$/.test(normalized);
}

function extractDecision(
  section: string | null | undefined,
  direction: "forward" | "reverse" = "reverse",
  maxLines: number | null = null
) {
  if (!section) {
    return { decision: "unknown", text: null as string | null };
  }

  const lines = section
    .split(/\n+/)
    .map((line) => compactWhitespace(line))
    .filter(Boolean);

  const orderedLines = (direction === "forward" ? lines : [...lines].reverse()).slice(
    0,
    maxLines ?? undefined
  );

  for (const line of orderedLines) {
    if (incompleteDecisionFragment(line)) {
      continue;
    }

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
  function validIsoDate(year: number, month: number, day: number) {
    if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }

    const candidate = new Date(Date.UTC(year, month - 1, day));

    if (
      candidate.getUTCFullYear() !== year ||
      candidate.getUTCMonth() !== month - 1 ||
      candidate.getUTCDate() !== day
    ) {
      return null;
    }

    return candidate.toISOString().slice(0, 10);
  }

  function fromText(value: string) {
    const numeric = value.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);

    if (numeric) {
      const yearValue = Number(numeric[3]);
      const parsed = validIsoDate(
        yearValue < 100 ? 2000 + yearValue : yearValue,
        Number(numeric[1]),
        Number(numeric[2])
      );

      if (parsed) {
        return parsed;
      }
    }

    const longDate = value.match(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/i
    );

    if (!longDate) {
      return null;
    }

    const parsed = new Date(`${longDate[1]} ${longDate[2]}, ${longDate[3]} UTC`);
    return Number.isNaN(parsed.getTime())
      ? null
      : validIsoDate(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
  }

  return fromText(title ?? "") ?? fromText(plainText);
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
  const posts = Array.isArray(raw.posts) ? raw.posts : [];
  const firstPost = posts[0];

  if (firstPost && typeof firstPost === "object" && !Array.isArray(firstPost)) {
    const firstPostText = stringValue((firstPost as Record<string, unknown>).plainText);

    if (firstPostText) {
      return firstPostText;
    }
  }

  return stringValue(raw.fullText) ?? "";
}

function meetingGrantSections(plainText: string) {
  const lines = lineEntries(plainText);
  const keyTakeawaysHeading = lines.find(
    (line) => normalizeTitle(line.text) === "key takeaways"
  );
  const grantHeadings = lines.filter((line) => {
    const normalized = normalizeTitle(line.text);
    return normalized === "open grant proposals" || normalized === "open grants";
  });
  const headingsAfterKeyTakeaways = keyTakeawaysHeading
    ? grantHeadings.filter((heading) => heading.start > keyTakeawaysHeading.end)
    : grantHeadings;
  const summaryHeading = headingsAfterKeyTakeaways[0] ?? null;
  const detailHeading = headingsAfterKeyTakeaways[1] ?? (keyTakeawaysHeading ? null : grantHeadings.at(-1) ?? null);

  if (
    keyTakeawaysHeading &&
    summaryHeading &&
    detailHeading &&
    detailHeading.start > summaryHeading.end
  ) {
    return {
      keyTakeaways: plainText.slice(summaryHeading.end, detailHeading.start).trim(),
      detailedText: plainText.slice(detailHeading.end).trim()
    };
  }

  if (summaryHeading && keyTakeawaysHeading) {
    return {
      keyTakeaways: plainText.slice(summaryHeading.end).trim(),
      detailedText: ""
    };
  }

  if (detailHeading) {
    return {
      keyTakeaways: "",
      detailedText: plainText.slice(detailHeading.end).trim()
    };
  }

  return {
    keyTakeaways: keyTakeawaysHeading ? plainText.slice(keyTakeawaysHeading.end).trim() : "",
    detailedText: plainText
  };
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

function decisionMentionsFromRecord(
  record: RawSourceRecord,
  excludedForumTopicIds: ReadonlySet<string> = new Set()
) {
  const raw = parseJsonRecord(record.raw_payload);
  const source = decisionSourceFromRecord(record);

  if (!source) {
    return { source: null, mentions: [] as ParsedDecisionMention[] };
  }

  const plainText = plainTextFromRawPayload(raw);
  const sourceUrl = normalizeUrl(record.source_url ?? record.source_id);
  const links = linksFromRawPayload(raw)
    .filter((link) => normalizeUrl(link.url) !== sourceUrl)
    .filter((link) => {
      const topicId = discourseTopicId(link.url);
      return !topicId || !excludedForumTopicIds.has(topicId);
    });
  const uniqueLinks = new Map<string, { url: string; title: string }>();

  for (const link of links) {
    if (!uniqueLinks.has(link.url)) {
      uniqueLinks.set(link.url, link);
    }
  }

  const grantLinks = [...uniqueLinks.values()];
  const titles = grantLinks.map((link) => link.title);
  const { keyTakeaways, detailedText } = meetingGrantSections(plainText);
  const keySections = titleSections(keyTakeaways, titles);
  const detailedSections = titleSections(detailedText, titles);
  const mentions = grantLinks
    .map((link): ParsedDecisionMention | null => {
      const keySection = keySections.get(link.title) ?? null;
      const detailSection = detailedSections.get(link.title) ?? null;

      if (!keySection && !detailSection) {
        return null;
      }

      const decision = keySection
        ? extractDecision(keySection, "forward", 3)
        : extractDecision(detailSection, "reverse");
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
          decisionSection: keySection ? "key_takeaways" : "detailed_minutes",
          hasDetailedRationale: Boolean(rationaleText),
          sourceRecordId: record.id
        }
      };
    })
    .filter((mention): mention is ParsedDecisionMention => mention !== null)
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
              checksum_sha256,
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
            sl.confidence::text,
            sl.relationship_role
       from source_links sl
       join source_records sr on sr.id = sl.source_record_id
       join grant_applications ga on ga.id = sl.canonical_id
      where sl.canonical_type = 'grant_application'`
  );

  return result.rows;
}

async function fetchManualSourceLinkIndex() {
  const result = await query<SourceLinkIndexRow>(
    `select ga.id::text as application_id,
            ga.canonical_key,
            ga.title,
            ga.normalized_status,
            ''::text as source_record_id,
            d.source_kind,
            d.source_id,
            d.source_id as source_url,
            d.confidence::text,
            'manual_source_decision'::text as relationship_role
       from reconciliation_decisions d
       join grant_applications ga on ga.canonical_key = d.canonical_key
      where d.status = 'active'
        and d.decision_type = 'link_source'
        and d.canonical_type = 'grant_application'
        and d.source_kind is not null
        and d.source_id is not null`
  );

  return result.rows;
}

function discourseTopicId(value: string | null | undefined) {
  const normalized = normalizeUrl(value);

  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);

    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.hostname !== "forum.zcashcommunity.com"
    ) {
      return null;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);

    if (segments[0] !== "t") {
      return null;
    }

    const topicId = /^\d+$/.test(segments[1] ?? "")
      ? segments[1]
      : /^\d+$/.test(segments[2] ?? "")
        ? segments[2]
        : null;

    return topicId;
  } catch {
    return null;
  }
}

function sourceLinkRolePriority(row: SourceLinkIndexRow) {
  if (row.relationship_role === "manual_source_decision") {
    return 200;
  }

  if (row.relationship_role === "primary_forum_thread" || row.source_kind === "grant_application") {
    return 100;
  }

  if (row.relationship_role === "supporting_forum_reference") {
    return 0;
  }

  return 50;
}

function chooseUniqueBestSourceLink(rows: SourceLinkIndexRow[]) {
  if (!rows.length) {
    return { row: null, ambiguous: false };
  }

  const bestPriority = Math.max(...rows.map(sourceLinkRolePriority));
  const priorityRows = rows.filter((row) => sourceLinkRolePriority(row) === bestPriority);
  const bestConfidence = Math.max(...priorityRows.map((row) => Number(row.confidence)));
  const bestRows = priorityRows.filter((row) => Number(row.confidence) === bestConfidence);
  const applicationIds = new Set(bestRows.map((row) => row.application_id));

  if (applicationIds.size !== 1) {
    return { row: null, ambiguous: true };
  }

  const row = [...bestRows].sort((left, right) => {
    const sourceComparison = left.source_record_id.localeCompare(right.source_record_id);
    return sourceComparison || left.application_id.localeCompare(right.application_id);
  })[0] ?? null;

  return { row, ambiguous: false };
}

function buildDirectMatchIndexes(
  sourceLinks: SourceLinkIndexRow[],
  applications: GrantApplicationIndexRow[]
): DirectMatchIndexes {
  const candidatesByUrl = new Map<string, SourceLinkIndexRow[]>();
  const primaryCandidatesByTopicId = new Map<string, SourceLinkIndexRow[]>();

  function addUrlCandidate(url: string | null | undefined, row: SourceLinkIndexRow) {
    const normalized = normalizeUrl(url);

    if (!normalized || row.relationship_role === "supporting_forum_reference") {
      return;
    }

    const existing = candidatesByUrl.get(normalized) ?? [];
    existing.push(row);
    candidatesByUrl.set(normalized, existing);
  }

  function addPrimaryTopicCandidate(url: string | null | undefined, row: SourceLinkIndexRow) {
    if (row.relationship_role !== "primary_forum_thread") {
      return;
    }

    const topicId = discourseTopicId(url);

    if (!topicId) {
      return;
    }

    const existing = primaryCandidatesByTopicId.get(topicId) ?? [];
    existing.push(row);
    primaryCandidatesByTopicId.set(topicId, existing);
  }

  for (const row of sourceLinks) {
    addUrlCandidate(row.source_url, row);
    addUrlCandidate(row.source_id, row);
    addPrimaryTopicCandidate(row.source_url, row);
    addPrimaryTopicCandidate(row.source_id, row);
  }

  for (const application of applications) {
    const githubIssueUrl = normalizeUrl(application.github_issue_url);

    if (githubIssueUrl) {
      addUrlCandidate(githubIssueUrl, {
        application_id: application.id,
        canonical_key: application.canonical_key,
        title: application.title,
        normalized_status: application.normalized_status,
        source_record_id: "",
        source_kind: "grant_application",
        source_id: application.canonical_key,
        source_url: application.github_issue_url,
        confidence: "1",
        relationship_role: "github_issue"
      });
    }
  }

  const byUrl = new Map<string, SourceLinkIndexRow>();
  const ambiguousUrls = new Set<string>();

  for (const [url, rows] of candidatesByUrl) {
    const selected = chooseUniqueBestSourceLink(rows);

    if (selected.row) {
      byUrl.set(url, selected.row);
    } else if (selected.ambiguous) {
      ambiguousUrls.add(url);
    }
  }

  const byPrimaryForumTopicId = new Map<string, SourceLinkIndexRow>();

  for (const [topicId, rows] of primaryCandidatesByTopicId) {
    const applicationsForTopic = new Set(rows.map((row) => row.application_id));

    if (applicationsForTopic.size !== 1) {
      continue;
    }

    const selected = chooseUniqueBestSourceLink(rows);

    if (selected.row) {
      byPrimaryForumTopicId.set(topicId, selected.row);
    }
  }

  return { byUrl, ambiguousUrls, byPrimaryForumTopicId };
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
  directIndexes: DirectMatchIndexes,
  applications: GrantApplicationIndexRow[]
): MatchedDecisionMention {
  const direct = mention.linkedSourceUrl ? directIndexes.byUrl.get(mention.linkedSourceUrl) : null;

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

  const topicId = discourseTopicId(mention.linkedSourceUrl);
  const primaryForumMatch = topicId
    ? directIndexes.byPrimaryForumTopicId.get(topicId)
    : null;

  if (primaryForumMatch) {
    return {
      ...mention,
      applicationId: primaryForumMatch.application_id,
      linkedSourceRecordId: primaryForumMatch.source_record_id || null,
      matchMethod: "primary_forum_topic_id",
      confidence: Number(primaryForumMatch.confidence),
      reviewStatus: "accepted"
    };
  }

  if (mention.linkedSourceUrl && directIndexes.ambiguousUrls.has(mention.linkedSourceUrl)) {
    return {
      ...mention,
      applicationId: null,
      linkedSourceRecordId: null,
      matchMethod: "ambiguous_direct_source_url",
      confidence: 0,
      reviewStatus: "needs_review"
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

async function markGeneratedMentionsStale() {
  await query(
    `update grant_decision_mentions
        set review_status = 'stale',
            updated_at = now()
      where metadata->>'generatedBy' = $1
        and review_status <> 'stale'`,
    [generatedBy]
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

function normalizedTerminalStatus(decision: string) {
  if (decision === "approved_async") {
    return "approved";
  }

  return isTerminalDecision(decision) ? decision : null;
}

function exactDecisionStatusAssertion(
  application: GrantApplicationIndexRow,
  mention: MatchedDecisionMention,
  mentionId: string,
  source: DecisionSourceInput,
  record: RawSourceRecord
) {
  const toStatus = normalizedTerminalStatus(mention.normalizedDecision);

  if (
    !toStatus ||
    !source.meetingDate ||
    mention.reviewStatus !== "accepted" ||
    mention.confidence < 0.86 ||
    !isHighConfidenceDecisionMention(mention)
  ) {
    return null;
  }

  return {
    applicationId: application.id,
    applicationCanonicalKey: application.canonical_key,
    toStatus,
    effectiveDate: source.meetingDate,
    observedAt: null as string | null,
    confidence: mention.confidence,
    sourceRecordId: record.id,
    sourceKind: record.source_kind,
    sourceId: record.source_id,
    sourceUrl: source.topicUrl,
    sourceChecksumSha256: record.checksum_sha256 ?? null,
    evidenceLocator: `decision-mention:${mentionId}:meeting-date`,
    evidenceFingerprint: mention.contentHash,
    idempotencyKey: `decision-mention:${mentionId}:${mention.contentHash}`,
    evidence: {
      basis: "accepted_decision_minutes",
      mentionId,
      mentionKey: mention.mentionKey,
      normalizedDecision: mention.normalizedDecision,
      decisionText: mention.decisionText,
      meetingDate: source.meetingDate,
      meetingTitle: source.title,
      matchMethod: mention.matchMethod,
      reviewStatus: mention.reviewStatus,
      parserVersion,
      sourceRecordId: record.id,
      sourceChecksumSha256: record.checksum_sha256 ?? null
    }
  };
}

async function recordExactDecisionStatusAssertion(
  application: GrantApplicationIndexRow,
  mention: MatchedDecisionMention,
  mentionId: string,
  source: DecisionSourceInput,
  record: RawSourceRecord,
  context: GrantDecisionMinutesContext
) {
  const assertion = exactDecisionStatusAssertion(application, mention, mentionId, source, record);

  if (!assertion) {
    return;
  }

  await query(
    `insert into grant_application_status_events (
       application_id,
       application_canonical_key,
       event_type,
       to_status,
       provenance,
       effective_date,
       observed_at,
       confidence,
       source_record_id,
       source_kind,
       source_id,
       source_url,
       source_checksum_sha256,
       source_field,
       sync_run_id,
       reconciliation_run_id,
       evidence_locator,
       evidence_fingerprint,
       idempotency_key,
       evidence
     )
     values (
       $1, $2, 'historical_assertion', $3, 'exact', $4::date,
       coalesce($5::timestamptz, clock_timestamp()), $6,
       $7, $8, $9, $10, $11, 'meeting_date',
       $12::uuid, $13::uuid, $14, $15, $16, $17::jsonb
     )
     on conflict (idempotency_key) do nothing`,
    [
      assertion.applicationId,
      assertion.applicationCanonicalKey,
      assertion.toStatus,
      assertion.effectiveDate,
      context.observedAt ?? assertion.observedAt,
      assertion.confidence,
      assertion.sourceRecordId,
      assertion.sourceKind,
      assertion.sourceId,
      assertion.sourceUrl,
      assertion.sourceChecksumSha256,
      context.syncRunId ?? null,
      context.reconciliationRunId ?? null,
      assertion.evidenceLocator,
      assertion.evidenceFingerprint,
      assertion.idempotencyKey,
      JSON.stringify(assertion.evidence)
    ]
  );
}

function terminalDecisionConflict(decision: string, applicationStatus: string | null | undefined) {
  const status = applicationStatus ?? "unknown";

  if (decision === "approved" || decision === "approved_async") {
    return !["approved", "active", "completed", "cancelled", "withdrawn"].includes(status);
  }

  if (decision === "declined") {
    return !["declined", "filtered"].includes(status);
  }

  if (decision === "withdrawn") {
    return status !== "withdrawn";
  }

  if (decision === "cancelled") {
    return status !== "cancelled";
  }

  if (decision === "filtered") {
    return !["filtered", "declined"].includes(status);
  }

  return false;
}

function isTerminalDecision(decision: string) {
  return ["approved", "approved_async", "declined", "withdrawn", "cancelled", "filtered"].includes(
    decision
  );
}

function partialDecisionConflict(applicationStatus: string | null | undefined) {
  return !["approved", "active", "completed"].includes(applicationStatus ?? "unknown");
}

function isHighConfidenceDecisionMention(mention: MatchedDecisionMention) {
  return mention.metadata.decisionSection === "key_takeaways";
}

function mentionChronologyDate(mention: LinkedMentionForReview) {
  return mention.source.meetingDate ?? mention.sourceUpdatedAt?.slice(0, 10) ?? "0000-00-00";
}

function latestMentionGroups(mentions: LinkedMentionForReview[]) {
  const byApplication = new Map<string, LinkedMentionForReview[]>();

  for (const mention of mentions) {
    const existing = byApplication.get(mention.application.id) ?? [];
    existing.push(mention);
    byApplication.set(mention.application.id, existing);
  }

  return [...byApplication.values()].map((applicationMentions) => {
    const latestDate = applicationMentions.reduce((latest, mention) => {
      const date = mentionChronologyDate(mention);
      return date > latest ? date : latest;
    }, "0000-00-00");

    return applicationMentions
      .filter((mention) => mentionChronologyDate(mention) === latestDate)
      .sort((left, right) => {
        const sourceComparison = left.sourceRecordId.localeCompare(right.sourceRecordId);
        return sourceComparison || left.mentionId.localeCompare(right.mentionId);
      });
  });
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

export async function reconcileGrantDecisionMinutes(
  context: GrantDecisionMinutesContext = {}
): Promise<GrantDecisionMinutesResult> {
  const records = await fetchDecisionMinuteRecords();
  const applications = await fetchApplications();
  const [sourceLinks, manualSourceLinks] = await Promise.all([
    fetchSourceLinkIndex(),
    fetchManualSourceLinkIndex()
  ]);
  const directIndexes = buildDirectMatchIndexes(
    [...sourceLinks, ...manualSourceLinks],
    applications
  );
  const applicationsById = new Map(applications.map((application) => [application.id, application]));
  const decisionMinuteTopicIds = new Set(
    records
      .map((record) => discourseTopicId(record.source_url ?? record.source_id))
      .filter((topicId): topicId is string => Boolean(topicId))
  );
  const linkedMentionsForReview: LinkedMentionForReview[] = [];
  const result: GrantDecisionMinutesResult = {
    sourcesParsed: 0,
    mentionsParsed: 0,
    mentionsLinked: 0,
    mentionsNeedingReview: 0,
    issuesCreated: 0
  };

  await deleteOpenGeneratedIssues();
  await markGeneratedMentionsStale();

  for (const record of records) {
    const { source, mentions } = decisionMentionsFromRecord(record, decisionMinuteTopicIds);

    if (!source) {
      continue;
    }

    const decisionSourceId = await upsertDecisionSource(source);

    if (!decisionSourceId) {
      continue;
    }

    result.sourcesParsed += 1;
    result.mentionsParsed += mentions.length;

    for (const mention of mentions) {
      const matched = matchMention(mention, directIndexes, applications);
      const mentionId = await upsertDecisionMention(decisionSourceId, matched);

      if (matched.applicationId) {
        await linkDecisionSourceToApplication(record.id, matched.applicationId, matched.confidence);
        result.mentionsLinked += 1;

        const application = applicationsById.get(matched.applicationId);

        if (application && mentionId) {
          await recordExactDecisionStatusAssertion(
            application,
            matched,
            mentionId,
            source,
            record,
            context
          );
        }

        if (application && mentionId && isHighConfidenceDecisionMention(matched)) {
          linkedMentionsForReview.push({
            application,
            matched,
            mentionId,
            source,
            sourceUpdatedAt: record.source_updated_at,
            sourceRecordId: record.id
          });
        }

        continue;
      }

      result.mentionsNeedingReview += 1;
      await createIssue({
        issueType: "unlinked_decision_minutes",
        severity:
          isHighConfidenceDecisionMention(matched) &&
          (isTerminalDecision(matched.normalizedDecision) || matched.normalizedDecision === "partial_approval")
            ? "warning"
            : "info",
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

  for (const group of latestMentionGroups(linkedMentionsForReview)) {
    const representative = group[0];

    if (!representative) {
      continue;
    }

    const normalizedDecisions = new Set(
      group.map((mention) =>
        mention.matched.normalizedDecision === "approved_async"
          ? "approved"
          : mention.matched.normalizedDecision
      )
    );

    if (normalizedDecisions.has("partial_approval")) {
      if (partialDecisionConflict(representative.application.normalized_status)) {
        await createIssue({
          issueType: "partial_decision_status_review",
          severity: "warning",
          sourceRecordId: representative.sourceRecordId,
          applicationId: representative.application.id,
          summary: `Meeting minutes record a partial approval for ${representative.application.title}`,
          details: {
            mentionId: representative.mentionId,
            meetingTitle: representative.source.title,
            meetingDate: representative.source.meetingDate,
            candidateTitle: representative.matched.candidateTitle,
            linkedSourceUrl: representative.matched.linkedSourceUrl,
            normalizedDecision: representative.matched.normalizedDecision,
            canonicalStatus: representative.application.normalized_status,
            matchMethod: representative.matched.matchMethod,
            confidence: representative.matched.confidence
          }
        });
        result.issuesCreated += 1;
      }

      continue;
    }

    const terminalMentions = group.filter((mention) =>
      isTerminalDecision(mention.matched.normalizedDecision)
    );

    if (terminalMentions.length !== group.length) {
      continue;
    }

    const terminalDecisions = new Set(
      terminalMentions.map((mention) =>
        mention.matched.normalizedDecision === "approved_async"
          ? "approved"
          : mention.matched.normalizedDecision
      )
    );

    if (terminalDecisions.size > 1) {
      await createIssue({
        issueType: "ambiguous_latest_decision_minutes",
        severity: "warning",
        sourceRecordId: representative.sourceRecordId,
        applicationId: representative.application.id,
        summary: `Meeting minutes contain conflicting latest decisions for ${representative.application.title}`,
        details: {
          meetingDate: representative.source.meetingDate,
          canonicalStatus: representative.application.normalized_status,
          decisions: [...terminalDecisions],
          mentionIds: terminalMentions.map((mention) => mention.mentionId)
        }
      });
      result.issuesCreated += 1;
      continue;
    }

    const latest = terminalMentions[0];

    if (
      latest &&
      terminalDecisionConflict(
        latest.matched.normalizedDecision,
        latest.application.normalized_status
      )
    ) {
      await createIssue({
        issueType: "decision_status_conflict",
        severity: "warning",
        sourceRecordId: latest.sourceRecordId,
        applicationId: latest.application.id,
        summary: `Latest meeting minutes decision conflicts with canonical status for ${latest.application.title}`,
        details: {
          mentionId: latest.mentionId,
          meetingTitle: latest.source.title,
          meetingDate: latest.source.meetingDate,
          candidateTitle: latest.matched.candidateTitle,
          linkedSourceUrl: latest.matched.linkedSourceUrl,
          normalizedDecision: latest.matched.normalizedDecision,
          canonicalStatus: latest.application.normalized_status,
          matchMethod: latest.matched.matchMethod,
          confidence: latest.matched.confidence
        }
      });
      result.issuesCreated += 1;
    }
  }

  return result;
}

export const decisionMinutesTestHooks = {
  buildDirectMatchIndexes,
  decisionMentionsFromRecord,
  discourseTopicId,
  exactDecisionStatusAssertion,
  extractDecision,
  extractMeetingDate,
  isHighConfidenceDecisionMention,
  latestMentionGroups,
  matchMention,
  meetingGrantSections,
  normalizeDecisionLine,
  partialDecisionConflict,
  terminalDecisionConflict,
  titleSections
};
