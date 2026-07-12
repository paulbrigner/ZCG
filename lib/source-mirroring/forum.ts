import type { ForumMirrorConfig, SourceMirrorRecord, SourceMirrorResult } from "./types";

export type DiscoursePost = {
  id: number;
  name?: string | null;
  username?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  cooked?: string | null;
  post_number?: number | null;
  post_type?: number | null;
  reply_to_post_number?: number | null;
  topic_id?: number | null;
  topic_slug?: string | null;
};

export type DiscourseTopic = {
  id: number;
  title?: string | null;
  fancy_title?: string | null;
  slug?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_posted_at?: string | null;
  bumped_at?: string | null;
  posts_count?: number | null;
  reply_count?: number | null;
  views?: number | null;
  tags?: string[];
  category_id?: number | null;
  post_stream?: {
    posts?: DiscoursePost[];
    stream?: number[];
  };
};

type DiscourseCategoryTopic = {
  id: number;
  title?: string | null;
  fancy_title?: string | null;
  slug?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_posted_at?: string | null;
  bumped_at?: string | null;
  posts_count?: number | null;
  reply_count?: number | null;
  views?: number | null;
  category_id?: number | null;
  tags?: string[];
};

type DiscourseCategoryResponse = {
  topic_list?: {
    more_topics_url?: string | null;
    topics?: DiscourseCategoryTopic[];
  };
};

export type ForumTopicReference = {
  topicId: number;
  slug: string | null;
  canonicalUrl: string;
  referencedUrl: string;
  referencedPostNumber: number | null;
};

export type MirroredForumTopic = {
  reference: ForumTopicReference;
  references: ForumTopicReference[];
  jsonUrl: string;
  topic: DiscourseTopic;
  posts: Array<DiscoursePost & { plainText: string }>;
  streamPostIds: number[];
  coverageComplete: boolean;
  coverageCapped: boolean;
  missingPostIds: number[];
  fetchFailures: Array<{ postIds: number[]; error: string }>;
  rateLimited: boolean;
};

export type ForumFetchDependencies = {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
};

type ForumFetchOptions = ForumFetchDependencies & {
  maxPosts: number;
  batchSize?: number;
  batchDelayMs?: number;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
};

type TopicRecordOptions = {
  sourceKind?: string;
  mirrorKind?: string;
  metadata?: Record<string, unknown>;
};

const forumUrlPattern = /https?:\/\/forum\.zcashcommunity\.com\/t\/[^\s)"'<\]}]+/gi;
const forumOrigin = "https://forum.zcashcommunity.com";
const genericForumTopicSlugs = new Set(["zcg-code-of-conduct", "zcg-communication-guidelines"]);
const defaultUpdatesCategoryUrl = "https://forum.zcashcommunity.com/c/grants/zomg-updates/34";
const defaultMaxTopics = 2000;
const defaultMaxPostsPerLinkedTopic = 1000;
const defaultMaxPostsPerUpdatesTopic = 20;
const hardMaxPostsPerTopic = 1000;
const defaultFetchDelayMs = 500;
const defaultMaxCategoryPages = 25;
const discoursePostBatchSize = 20;
const defaultPostBatchDelayMs = 250;
const defaultMaxFetchAttempts = 5;
const defaultBaseRetryDelayMs = 500;

class ForumRateLimitError extends Error {
  retryAfterMs: number | null;

  constructor(url: string, retryAfterMs: number | null = null) {
    super(`Zcash Forum mirror was rate limited while fetching ${url}.`);
    this.name = "ForumRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

function numberConfig(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredUrls(config?: ForumMirrorConfig) {
  if (config?.urls?.length) {
    return config.urls;
  }

  return (process.env.ZCG_FORUM_TOPIC_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

function skippedUrls(config?: ForumMirrorConfig) {
  return new Set(
    (config?.skipUrls ?? [])
      .map((url) => normalizeForumTopicUrl(url))
      .filter((url): url is string => Boolean(url))
  );
}

function maxTopics(config?: ForumMirrorConfig) {
  return numberConfig(config?.maxTopics ?? process.env.ZCG_FORUM_MAX_TOPICS, defaultMaxTopics);
}

function maxPostsPerLinkedTopic(config?: ForumMirrorConfig) {
  return Math.min(
    hardMaxPostsPerTopic,
    numberConfig(
      config?.maxPostsPerLinkedTopic ??
        config?.maxPostsPerTopic ??
        process.env.ZCG_FORUM_MAX_POSTS_PER_LINKED_TOPIC ??
        process.env.ZCG_FORUM_MAX_POSTS_PER_TOPIC,
      defaultMaxPostsPerLinkedTopic
    )
  );
}

function maxPostsPerUpdatesTopic(config?: ForumMirrorConfig) {
  return Math.min(
    hardMaxPostsPerTopic,
    numberConfig(
      config?.maxPostsPerUpdatesTopic ??
        config?.maxPostsPerTopic ??
        process.env.ZCG_FORUM_MAX_POSTS_PER_UPDATES_TOPIC ??
        process.env.ZCG_FORUM_MAX_POSTS_PER_TOPIC,
      defaultMaxPostsPerUpdatesTopic
    )
  );
}

function maxCategoryPages(config?: ForumMirrorConfig) {
  return numberConfig(config?.maxCategoryPages ?? process.env.ZCG_FORUM_MAX_CATEGORY_PAGES, defaultMaxCategoryPages);
}

function fetchDelayMs(config?: ForumMirrorConfig) {
  return numberConfig(config?.fetchDelayMs ?? process.env.ZCG_FORUM_FETCH_DELAY_MS, defaultFetchDelayMs);
}

function updatesCategoryUrl(config?: ForumMirrorConfig) {
  return config?.updatesCategoryUrl ?? process.env.ZCG_FORUM_UPDATES_CATEGORY_URL ?? defaultUpdatesCategoryUrl;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(value: string) {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "...",
    ldquo: '"',
    lsquo: "'",
    lt: "<",
    mdash: "-",
    nbsp: " ",
    ndash: "-",
    quot: '"',
    rdquo: '"',
    rsquo: "'"
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const normalizedEntity = entity.toLowerCase();

    if (normalizedEntity.startsWith("#x")) {
      const codePoint = Number.parseInt(normalizedEntity.slice(2), 16);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }

    if (normalizedEntity.startsWith("#")) {
      const codePoint = Number.parseInt(normalizedEntity.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }

    return namedEntities[normalizedEntity] ?? match;
  });
}

function htmlToPlainText(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

function stripHtml(value: string) {
  return htmlToPlainText(value);
}

function absoluteForumUrl(value: string) {
  try {
    return new URL(value, "https://forum.zcashcommunity.com").toString();
  } catch {
    return value;
  }
}

function htmlLinks(value: string | null | undefined) {
  if (!value) {
    return [];
  }

  const links: Array<{ href: string; text: string; normalizedUrl: string | null; htmlOffset: number }> = [];
  const pattern = /<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value))) {
    const href = absoluteForumUrl(decodeHtmlEntities(match[2] ?? ""));
    const text = stripHtml(match[3] ?? "");

    links.push({
      href,
      text,
      normalizedUrl: normalizeForumTopicUrl(href),
      htmlOffset: match.index
    });
  }

  return links;
}

export function parseForumTopicReference(value: string): ForumTopicReference | null {
  const trimmed = value.replace(/[.,;:]+$/g, "").replace(/\/+$/g, "");

  try {
    const parsed = new URL(trimmed);

    if (parsed.hostname !== "forum.zcashcommunity.com" || !parsed.pathname.startsWith("/t/")) {
      return null;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    const slugOrTopicId = segments[1] ?? null;
    const idOnlyPath = Boolean(slugOrTopicId?.match(/^\d+$/));
    const slug = idOnlyPath ? null : slugOrTopicId;
    const topicIdValue = idOnlyPath ? slugOrTopicId : segments[2];
    const postNumberValue = idOnlyPath ? segments[2] : segments[3];
    const topicId = Number(topicIdValue);
    const pathPostNumber = Number(postNumberValue);
    const hashPostNumber = Number(parsed.hash.match(/^#post_(\d+)$/i)?.[1]);
    const referencedPostNumber = Number.isInteger(pathPostNumber) && pathPostNumber > 0
      ? pathPostNumber
      : Number.isInteger(hashPostNumber) && hashPostNumber > 0
        ? hashPostNumber
        : null;

    if (
      !slugOrTopicId ||
      !Number.isInteger(topicId) ||
      topicId <= 0 ||
      (slug && genericForumTopicSlugs.has(slug))
    ) {
      return null;
    }

    const canonicalPath = slug ? `/t/${slug}/${topicId}` : `/t/${topicId}`;
    const canonicalUrl = `${forumOrigin}${canonicalPath}`;
    const referencedUrl = `${canonicalUrl}${referencedPostNumber ? `/${referencedPostNumber}` : ""}`;

    return {
      topicId,
      slug,
      canonicalUrl,
      referencedUrl,
      referencedPostNumber
    };
  } catch {
    return null;
  }
}

export function normalizeForumTopicUrl(value: string) {
  return parseForumTopicReference(value)?.referencedUrl ?? null;
}

export function forumTopicUrlsFromText(value: string) {
  const urls = new Set<string>();
  const matches = value.match(forumUrlPattern) ?? [];

  for (const match of matches) {
    const url = normalizeForumTopicUrl(match);

    if (url) {
      urls.add(url);
    }
  }

  return [...urls];
}

function topicJsonUrl(topicUrl: string) {
  const parsed = new URL(topicUrl);
  parsed.pathname = `${parsed.pathname}.json`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function postsBatchJsonUrl(reference: ForumTopicReference, postIds: number[]) {
  const url = new URL(`/t/${reference.topicId}/posts.json`, reference.canonicalUrl);

  for (const postId of postIds) {
    url.searchParams.append("post_ids[]", String(postId));
  }

  return url.toString();
}

function forumHeaders() {
  return {
    accept: "application/json",
    "user-agent": "zcg-grants-prototype"
  };
}

function retryAfterMs(value: string | null) {
  if (!value) {
    return null;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

async function fetchJson<T>(
  url: string,
  dependencies: ForumFetchDependencies = {},
  options: { maxAttempts?: number; baseRetryDelayMs?: number } = {}
) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleepImpl = dependencies.sleepImpl ?? sleep;
  const randomImpl = dependencies.randomImpl ?? Math.random;
  const attempts = Math.max(1, options.maxAttempts ?? defaultMaxFetchAttempts);
  const baseDelayMs = Math.max(1, options.baseRetryDelayMs ?? defaultBaseRetryDelayMs);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response;

    try {
      response = await fetchImpl(url, { headers: forumHeaders() });
    } catch (error) {
      if (attempt === attempts) {
        throw new Error(
          `Zcash Forum mirror could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }

      const exponentialDelay = baseDelayMs * (2 ** (attempt - 1));
      const jitter = Math.floor(randomImpl() * baseDelayMs);
      await sleepImpl(exponentialDelay + jitter);
      continue;
    }

    if (response.status === 404 || response.status === 403 || response.status === 410) {
      return null;
    }

    if (response.ok) {
      return (await response.json()) as T;
    }

    const shouldRetry = response.status === 429 || response.status >= 500;
    const waitFromHeader = retryAfterMs(response.headers.get("retry-after"));

    if (!shouldRetry || attempt === attempts) {
      if (response.status === 429) {
        throw new ForumRateLimitError(url, waitFromHeader);
      }

      throw new Error(`Zcash Forum mirror failed for ${url}: ${response.status} ${response.statusText}`);
    }

    const exponentialDelay = baseDelayMs * (2 ** (attempt - 1));
    const jitter = Math.floor(randomImpl() * baseDelayMs);
    await sleepImpl(waitFromHeader ?? exponentialDelay + jitter);
  }

  throw new Error(`Zcash Forum mirror exhausted retries for ${url}.`);
}

function chunkValues<T>(values: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

export async function fetchCompleteForumTopic(
  reference: ForumTopicReference,
  options: ForumFetchOptions
): Promise<MirroredForumTopic | null> {
  const jsonUrl = topicJsonUrl(reference.canonicalUrl);
  const retryOptions = {
    maxAttempts: options.maxAttempts,
    baseRetryDelayMs: options.baseRetryDelayMs
  };
  const topic = await fetchJson<DiscourseTopic>(jsonUrl, options, retryOptions);

  if (!topic) {
    return null;
  }

  const maxPostCount = Math.min(hardMaxPostsPerTopic, Math.max(1, options.maxPosts));
  const batchSize = Math.min(discoursePostBatchSize, Math.max(1, options.batchSize ?? discoursePostBatchSize));
  const loadedPosts = topic.post_stream?.posts ?? [];
  const stream = (topic.post_stream?.stream ?? loadedPosts.map((post) => post.id))
    .filter((postId) => Number.isInteger(postId) && postId > 0);
  const selectedStreamPostIds = stream.slice(0, maxPostCount);
  const selectedPostIdSet = new Set(selectedStreamPostIds);
  const postsById = new Map(
    loadedPosts
      .filter((post) => selectedPostIdSet.has(post.id))
      .map((post) => [post.id, post] as const)
  );
  const fetchFailures: Array<{ postIds: number[]; error: string }> = [];
  let rateLimited = false;
  const missingPostIds = selectedStreamPostIds.filter((postId) => !postsById.has(postId));

  for (const [batchIndex, postIds] of chunkValues(missingPostIds, batchSize).entries()) {
    if (batchIndex > 0) {
      await (options.sleepImpl ?? sleep)(Math.max(0, options.batchDelayMs ?? defaultPostBatchDelayMs));
    }

    try {
      const response = await fetchJson<{ post_stream?: { posts?: DiscoursePost[] } }>(
        postsBatchJsonUrl(reference, postIds),
        options,
        retryOptions
      );

      for (const post of response?.post_stream?.posts ?? []) {
        if (selectedPostIdSet.has(post.id)) {
          postsById.set(post.id, post);
        }
      }
    } catch (error) {
      fetchFailures.push({ postIds, error: error instanceof Error ? error.message : String(error) });
      rateLimited = error instanceof ForumRateLimitError;
      break;
    }
  }

  const stillMissingPostIds = selectedStreamPostIds.filter((postId) => !postsById.has(postId));
  const coverageCapped = stream.length > selectedStreamPostIds.length;
  const posts = selectedStreamPostIds
    .map((postId) => postsById.get(postId))
    .filter((post): post is DiscoursePost => Boolean(post))
    .map((post) => ({ ...post, plainText: htmlToPlainText(post.cooked) }));

  return {
    reference,
    references: [reference],
    jsonUrl,
    topic,
    posts,
    streamPostIds: stream,
    coverageComplete: !coverageCapped && stillMissingPostIds.length === 0,
    coverageCapped,
    missingPostIds: stillMissingPostIds,
    fetchFailures,
    rateLimited
  };
}

function categoryJsonUrl(categoryUrl: string, page: number) {
  const parsed = new URL(categoryUrl);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/g, "")}.json`;
  parsed.search = page > 0 ? `?page=${page}` : "";
  parsed.hash = "";
  return parsed.toString();
}

function categoryTopicUrl(topic: DiscourseCategoryTopic) {
  const slug = topic.slug ?? String(topic.id);
  return normalizeForumTopicUrl(`https://forum.zcashcommunity.com/t/${slug}/${topic.id}`);
}

function isMeetingMinutesTopic(topic: DiscourseTopic | DiscourseCategoryTopic) {
  const title = `${topic.title ?? ""} ${topic.fancy_title ?? ""}`.toLowerCase();
  return title.includes("meeting minutes") && (
    title.includes("zcg") ||
    title.includes("zomg") ||
    title.includes("zcash community grants")
  );
}

function topicSummary(topic: MirroredForumTopic) {
  const firstPostText = topic.posts[0]?.plainText ?? "";
  return firstPostText.length > 300 ? `${firstPostText.slice(0, 297)}...` : firstPostText;
}

function topicTitle(topic: MirroredForumTopic) {
  return topic.topic.title ?? topic.topic.fancy_title ?? `Forum topic ${topic.topic.id}`;
}

function topicUpdatedAt(topic: MirroredForumTopic) {
  return topic.topic.last_posted_at ?? topic.topic.updated_at ?? topic.topic.bumped_at ?? topic.topic.created_at ?? null;
}

function topicRecord(
  topic: MirroredForumTopic,
  reference: ForumTopicReference,
  fetchedAt: string,
  options: TopicRecordOptions = {}
): SourceMirrorRecord {
  const posts = topic.posts.map((post) => ({
    id: post.id,
    postNumber: post.post_number ?? null,
    postType: post.post_type ?? null,
    replyToPostNumber: post.reply_to_post_number ?? null,
    username: post.username ?? null,
    name: post.name ?? null,
    createdAt: post.created_at ?? null,
    updatedAt: post.updated_at ?? null,
    plainText: post.plainText,
    cookedHtml: post.cooked ?? null,
    links: htmlLinks(post.cooked)
  }));
  const sourceKind = options.sourceKind ?? "forum_link";
  const mirrorKind = options.mirrorKind ?? "forum_topic";

  return {
    sourceKind,
    sourceId: reference.referencedUrl,
    sourceUrl: reference.referencedUrl,
    sourceUpdatedAt: topicUpdatedAt(topic),
    title: topicTitle(topic),
    summary: topicSummary(topic),
    rawPayload: {
      url: reference.referencedUrl,
      canonicalUrl: reference.canonicalUrl,
      referencedPostNumber: reference.referencedPostNumber,
      jsonUrl: topic.jsonUrl,
      topic: {
        id: topic.topic.id,
        title: topic.topic.title ?? null,
        fancyTitle: topic.topic.fancy_title ?? null,
        slug: topic.topic.slug ?? null,
        createdAt: topic.topic.created_at ?? null,
        updatedAt: topic.topic.updated_at ?? null,
        lastPostedAt: topic.topic.last_posted_at ?? null,
        bumpedAt: topic.topic.bumped_at ?? null,
        postsCount: topic.topic.posts_count ?? null,
        replyCount: topic.topic.reply_count ?? null,
        views: topic.topic.views ?? null,
        tags: topic.topic.tags ?? [],
        categoryId: topic.topic.category_id ?? null,
        streamPostIds: topic.streamPostIds
      },
      posts,
      coverage: {
        complete: topic.coverageComplete,
        capped: topic.coverageCapped,
        streamPostCount: topic.streamPostIds.length,
        fetchedPostCount: posts.length,
        missingPostIds: topic.missingPostIds,
        fetchFailures: topic.fetchFailures,
        rateLimited: topic.rateLimited
      },
      references: topic.references.map((item) => ({
        url: item.referencedUrl,
        postNumber: item.referencedPostNumber
      })),
      fullText: posts
        .map((post) => [`Post #${post.postNumber ?? "?"} by ${post.username ?? "unknown"}`, post.plainText].join("\n"))
        .join("\n\n")
    },
    metadata: {
      source: "forum_mirror",
      mirrorKind,
      fetchedAt,
      topicId: topic.topic.id,
      canonicalTopicUrl: reference.canonicalUrl,
      referencedPostNumber: reference.referencedPostNumber,
      categoryId: topic.topic.category_id ?? null,
      postCountFetched: posts.length,
      postCountReported: topic.topic.posts_count ?? null,
      postStreamCount: topic.streamPostIds.length,
      coverageComplete: topic.coverageComplete,
      coverageCapped: topic.coverageCapped,
      ...options.metadata
    }
  };
}

function topicRecords(topic: MirroredForumTopic, fetchedAt: string, options: TopicRecordOptions = {}) {
  return topic.references.map((reference) => topicRecord(topic, reference, fetchedAt, options));
}

export function groupForumTopicReferences(values: string[]) {
  const grouped = new Map<number, ForumTopicReference[]>();

  for (const value of values) {
    const reference = parseForumTopicReference(value);

    if (!reference) {
      continue;
    }

    const references = grouped.get(reference.topicId) ?? [];

    if (!references.some((item) => item.referencedUrl === reference.referencedUrl)) {
      references.push(reference);
      grouped.set(reference.topicId, references);
    }
  }

  return [...grouped.values()]
    .map((references) => references.sort((left, right) => left.referencedUrl.localeCompare(right.referencedUrl)))
    .sort((left, right) => left[0]!.topicId - right[0]!.topicId);
}

async function fetchForumTopic(
  references: ForumTopicReference[],
  maxPosts: number
): Promise<MirroredForumTopic | null> {
  const topic = await fetchCompleteForumTopic(references[0]!, { maxPosts });

  if (topic) {
    topic.references = references;
  }

  return topic;
}

export function forumTopicUrlsFromSourceRecords(records: SourceMirrorRecord[]) {
  const urls = new Set<string>();

  for (const record of records) {
    const text = JSON.stringify({
      sourceUrl: record.sourceUrl,
      rawPayload: record.rawPayload
    });

    for (const url of forumTopicUrlsFromText(text)) {
      urls.add(url);
    }
  }

  return [...urls].sort((left, right) => left.localeCompare(right));
}

export async function mirrorForumTopics(config: ForumMirrorConfig = {}): Promise<SourceMirrorResult> {
  const fetchedAt = new Date().toISOString();
  const maxTopicCount = maxTopics(config);
  const maxPostCount = maxPostsPerLinkedTopic(config);
  const delayMs = fetchDelayMs(config);
  const skippedTopicUrls = skippedUrls(config);
  const discoveredUrls = [
    ...new Set(
      configuredUrls(config)
        .map((url) => normalizeForumTopicUrl(url))
        .filter((url): url is string => Boolean(url))
    )
  ]
    .filter((url) => !skippedTopicUrls.has(url))
    .sort((left, right) => left.localeCompare(right));
  const topicReferenceGroups = groupForumTopicReferences(discoveredUrls).slice(0, maxTopicCount);
  const urls = topicReferenceGroups.flat().map((reference) => reference.referencedUrl);
  const records: SourceMirrorRecord[] = [];
  const failures: Array<{ url: string; error: string }> = [];
  let topicsMirrored = 0;
  let topicsWithPartialCoverage = 0;
  let rateLimitedAt: string | null = null;

  for (const [index, references] of topicReferenceGroups.entries()) {
    if (index > 0 && delayMs > 0) {
      await sleep(delayMs);
    }

    const url = references[0]!.canonicalUrl;

    try {
      const topic = await fetchForumTopic(references, maxPostCount);

      if (!topic) {
        failures.push({ url, error: "Topic unavailable or not public." });
        continue;
      }

      records.push(...topicRecords(topic, fetchedAt));
      topicsMirrored += 1;
      topicsWithPartialCoverage += topic.coverageComplete ? 0 : 1;

      if (topic.rateLimited) {
        rateLimitedAt = url;
        break;
      }
    } catch (error) {
      failures.push({ url, error: error instanceof Error ? error.message : String(error) });

      if (error instanceof ForumRateLimitError) {
        rateLimitedAt = url;
        break;
      }
    }
  }

  const topicCountSkippedAfterRateLimit = rateLimitedAt
    ? topicReferenceGroups.slice(
        topicReferenceGroups.findIndex((references) => references[0]?.canonicalUrl === rateLimitedAt) + 1
      ).length
    : 0;

  return {
    sourceKind: "forum_topics",
    sourceId: "forum.zcashcommunity.com",
    sourceUrl: "https://forum.zcashcommunity.com",
    rawPayload: {
      fetchedAt,
      topicCountRequested: topicReferenceGroups.length,
      referenceCountRequested: urls.length,
      topicCountSkippedConfigured: skippedTopicUrls.size,
      topicCountMirrored: topicsMirrored,
      topicCountPartial: topicsWithPartialCoverage,
      topicCountFailed: failures.length,
      topicCountSkippedAfterRateLimit,
      maxTopics: maxTopicCount,
      maxPostsPerLinkedTopic: maxPostCount,
      fetchDelayMs: delayMs,
      rateLimitedAt,
      urls,
      failures
    },
    records,
    metadata: {
      fetchedAt,
      topicCountRequested: topicReferenceGroups.length,
      referenceCountRequested: urls.length,
      topicCountSkippedConfigured: skippedTopicUrls.size,
      topicCountMirrored: topicsMirrored,
      topicCountPartial: topicsWithPartialCoverage,
      topicCountFailed: failures.length,
      topicCountSkippedAfterRateLimit,
      maxTopics: maxTopicCount,
      maxPostsPerLinkedTopic: maxPostCount,
      fetchDelayMs: delayMs,
      rateLimitedAt,
      recordCount: records.length
    }
  };
}

export async function mirrorForumUpdatesCategory(config: ForumMirrorConfig = {}): Promise<SourceMirrorResult> {
  const fetchedAt = new Date().toISOString();
  const categoryUrl = updatesCategoryUrl(config);
  const maxTopicCount = maxTopics(config);
  const maxPostCount = maxPostsPerUpdatesTopic(config);
  const maxPages = maxCategoryPages(config);
  const delayMs = fetchDelayMs(config);
  const skippedTopicUrls = skippedUrls(config);
  const topicUrls: string[] = [];
  const directTopicUrls = config.urls?.length
    ? [
        ...new Set(
          config.urls
            .map((url) => normalizeForumTopicUrl(url))
            .filter((url): url is string => Boolean(url))
        )
      ]
    : null;
  const categoryFailures: Array<{ url: string; error: string }> = [];
  const topicFailures: Array<{ url: string; error: string }> = [];
  let moreTopicsUrl: string | null = null;
  let rateLimitedAt: string | null = null;

  if (directTopicUrls) {
    topicUrls.push(...directTopicUrls);
  } else {
    for (let page = 0; page < maxPages && topicUrls.length < maxTopicCount; page += 1) {
      const url = categoryJsonUrl(categoryUrl, page);

      if (page > 0 && delayMs > 0) {
        await sleep(delayMs);
      }

      try {
        const category = await fetchJson<DiscourseCategoryResponse>(url);
        const topics = category?.topic_list?.topics ?? [];
        moreTopicsUrl = category?.topic_list?.more_topics_url ?? null;

        for (const topic of topics) {
          const topicUrl = categoryTopicUrl(topic);

          if (topicUrl) {
            topicUrls.push(topicUrl);
          }
        }

        if (!moreTopicsUrl || topics.length === 0) {
          break;
        }
      } catch (error) {
        categoryFailures.push({ url, error: error instanceof Error ? error.message : String(error) });

        if (error instanceof ForumRateLimitError) {
          rateLimitedAt = url;
          break;
        }
      }
    }
  }

  const discoveredUrls = [...new Set(topicUrls)];
  const selectedUrls = discoveredUrls.filter((url) => !skippedTopicUrls.has(url));
  const topicReferenceGroups = groupForumTopicReferences(selectedUrls).slice(0, maxTopicCount);
  const urls = topicReferenceGroups.flat().map((reference) => reference.referencedUrl);
  const records: SourceMirrorRecord[] = [];
  let topicsMirrored = 0;
  let topicsWithPartialCoverage = 0;

  for (const [index, references] of topicReferenceGroups.entries()) {
    if (index > 0 && delayMs > 0) {
      await sleep(delayMs);
    }

    const url = references[0]!.canonicalUrl;

    try {
      const topic = await fetchForumTopic(references, maxPostCount);

      if (!topic) {
        topicFailures.push({ url, error: "Topic unavailable or not public." });
        continue;
      }

      records.push(
        ...topicRecords(topic, fetchedAt, {
          sourceKind: isMeetingMinutesTopic(topic.topic) ? "forum_meeting_minutes" : "forum_update_topic",
          mirrorKind: isMeetingMinutesTopic(topic.topic) ? "forum_meeting_minutes" : "forum_update_topic",
          metadata: {
            categorySourceUrl: categoryUrl,
            categorySourceKind: "forum_updates_category"
          }
        })
      );
      topicsMirrored += 1;
      topicsWithPartialCoverage += topic.coverageComplete ? 0 : 1;

      if (topic.rateLimited) {
        rateLimitedAt = url;
        break;
      }
    } catch (error) {
      topicFailures.push({ url, error: error instanceof Error ? error.message : String(error) });

      if (error instanceof ForumRateLimitError) {
        rateLimitedAt = url;
        break;
      }
    }
  }

  return {
    sourceKind: "forum_updates_category",
    sourceId: categoryUrl,
    sourceUrl: categoryUrl,
    rawPayload: {
      fetchedAt,
      categoryUrl,
      directUrlMode: Boolean(directTopicUrls),
      topicCountDiscovered: discoveredUrls.length,
      topicCountSelected: topicReferenceGroups.length,
      referenceCountSelected: urls.length,
      topicCountSkippedConfigured: discoveredUrls.length - selectedUrls.length,
      topicCountMirrored: topicsMirrored,
      topicCountPartial: topicsWithPartialCoverage,
      topicCountFailed: topicFailures.length,
      maxTopics: maxTopicCount,
      maxCategoryPages: maxPages,
      maxPostsPerUpdatesTopic: maxPostCount,
      fetchDelayMs: delayMs,
      moreTopicsUrl,
      rateLimitedAt,
      urls,
      categoryFailures,
      topicFailures
    },
    records,
    metadata: {
      fetchedAt,
      categoryUrl,
      directUrlMode: Boolean(directTopicUrls),
      topicCountDiscovered: discoveredUrls.length,
      topicCountSelected: topicReferenceGroups.length,
      referenceCountSelected: urls.length,
      topicCountSkippedConfigured: discoveredUrls.length - selectedUrls.length,
      topicCountMirrored: topicsMirrored,
      topicCountPartial: topicsWithPartialCoverage,
      topicCountFailed: topicFailures.length,
      categoryFailureCount: categoryFailures.length,
      maxTopics: maxTopicCount,
      maxCategoryPages: maxPages,
      maxPostsPerUpdatesTopic: maxPostCount,
      fetchDelayMs: delayMs,
      rateLimitedAt,
      recordCount: records.length
    }
  };
}
