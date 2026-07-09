import type { ForumMirrorConfig, SourceMirrorRecord, SourceMirrorResult } from "./types";

type DiscoursePost = {
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

type DiscourseTopic = {
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

type MirroredForumTopic = {
  url: string;
  jsonUrl: string;
  topic: DiscourseTopic;
  posts: Array<DiscoursePost & { plainText: string }>;
};

type TopicRecordOptions = {
  sourceKind?: string;
  mirrorKind?: string;
  metadata?: Record<string, unknown>;
};

const forumUrlPattern = /https?:\/\/forum\.zcashcommunity\.com\/t\/[^\s)"'<\]}]+/gi;
const genericForumTopicSlugs = new Set(["zcg-code-of-conduct", "zcg-communication-guidelines"]);
const defaultUpdatesCategoryUrl = "https://forum.zcashcommunity.com/c/grants/zomg-updates/34";
const defaultMaxTopics = 2000;
const defaultMaxPostsPerTopic = 20;
const defaultFetchDelayMs = 500;
const defaultMaxCategoryPages = 25;

class ForumRateLimitError extends Error {
  constructor(url: string) {
    super(`Zcash Forum mirror was rate limited while fetching ${url}.`);
    this.name = "ForumRateLimitError";
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

function maxPostsPerTopic(config?: ForumMirrorConfig) {
  return numberConfig(
    config?.maxPostsPerTopic ?? process.env.ZCG_FORUM_MAX_POSTS_PER_TOPIC,
    defaultMaxPostsPerTopic
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

export function normalizeForumTopicUrl(value: string) {
  const trimmed = value.replace(/[.,;:]+$/g, "").replace(/\/+$/g, "");

  try {
    const parsed = new URL(trimmed);

    if (parsed.hostname !== "forum.zcashcommunity.com" || !parsed.pathname.startsWith("/t/")) {
      return null;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    const slug = segments[1];
    const topicIdMatch = segments[2]?.match(/^\d+/) ?? (slug?.match(/^\d+/) ?? null);
    const topicId = topicIdMatch?.[0] ?? null;
    const postNumberMatch = segments[3]?.match(/^\d+/) ?? null;
    const postNumber = postNumberMatch?.[0] ?? null;

    if (!slug || !topicId || genericForumTopicSlugs.has(slug)) {
      return null;
    }

    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = slug === topicId
      ? `/t/${topicId}${postNumber ? `/${postNumber}` : ""}`
      : `/t/${slug}/${topicId}${postNumber ? `/${postNumber}` : ""}`;
    return parsed.toString();
  } catch {
    return null;
  }
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

function forumHeaders() {
  return {
    accept: "application/json",
    "user-agent": "zcg-grants-prototype"
  };
}

async function fetchJson<T>(url: string) {
  const response = await fetch(url, { headers: forumHeaders() });

  if (response.status === 404 || response.status === 403 || response.status === 410) {
    return null;
  }

  if (response.status === 429) {
    throw new ForumRateLimitError(url);
  }

  if (!response.ok) {
    throw new Error(`Zcash Forum mirror failed for ${url}: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

async function fetchAdditionalPosts(topic: DiscourseTopic, maxPosts: number) {
  const loadedPosts = topic.post_stream?.posts ?? [];
  const loadedPostIds = new Set(loadedPosts.map((post) => post.id));
  const stream = topic.post_stream?.stream ?? [];
  const missingPostIds = stream
    .filter((postId) => !loadedPostIds.has(postId))
    .slice(0, Math.max(0, maxPosts - loadedPosts.length));
  const posts: DiscoursePost[] = [...loadedPosts];

  for (const postId of missingPostIds) {
    const post = await fetchJson<DiscoursePost>(`https://forum.zcashcommunity.com/posts/${postId}.json`);

    if (post) {
      posts.push(post);
    }
  }

  return posts
    .slice(0, maxPosts)
    .sort((left, right) => Number(left.post_number ?? 0) - Number(right.post_number ?? 0))
    .map((post) => ({
      ...post,
      plainText: htmlToPlainText(post.cooked)
    }));
}

async function fetchForumTopic(url: string, maxPosts: number): Promise<MirroredForumTopic | null> {
  const jsonUrl = topicJsonUrl(url);
  const topic = await fetchJson<DiscourseTopic>(jsonUrl);

  if (!topic) {
    return null;
  }

  return {
    url,
    jsonUrl,
    topic,
    posts: await fetchAdditionalPosts(topic, maxPosts)
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

function topicRecord(topic: MirroredForumTopic, fetchedAt: string, options: TopicRecordOptions = {}): SourceMirrorRecord {
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
    sourceId: topic.url,
    sourceUrl: topic.url,
    sourceUpdatedAt: topicUpdatedAt(topic),
    title: topicTitle(topic),
    summary: topicSummary(topic),
    rawPayload: {
      url: topic.url,
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
        categoryId: topic.topic.category_id ?? null
      },
      posts,
      fullText: posts
        .map((post) => [`Post #${post.postNumber ?? "?"} by ${post.username ?? "unknown"}`, post.plainText].join("\n"))
        .join("\n\n")
    },
    metadata: {
      source: "forum_mirror",
      mirrorKind,
      fetchedAt,
      topicId: topic.topic.id,
      categoryId: topic.topic.category_id ?? null,
      postCountFetched: posts.length,
      postCountReported: topic.topic.posts_count ?? null,
      ...options.metadata
    }
  };
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
  const maxPostCount = maxPostsPerTopic(config);
  const delayMs = fetchDelayMs(config);
  const skippedTopicUrls = skippedUrls(config);
  const urls = [
    ...new Set(
      configuredUrls(config)
        .map((url) => normalizeForumTopicUrl(url))
        .filter((url): url is string => Boolean(url))
    )
  ]
    .filter((url) => !skippedTopicUrls.has(url))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maxTopicCount);
  const records: SourceMirrorRecord[] = [];
  const failures: Array<{ url: string; error: string }> = [];
  let rateLimitedAt: string | null = null;

  for (const [index, url] of urls.entries()) {
    if (index > 0 && delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      const topic = await fetchForumTopic(url, maxPostCount);

      if (!topic) {
        failures.push({ url, error: "Topic unavailable or not public." });
        continue;
      }

      records.push(topicRecord(topic, fetchedAt));
    } catch (error) {
      failures.push({ url, error: error instanceof Error ? error.message : String(error) });

      if (error instanceof ForumRateLimitError) {
        rateLimitedAt = url;
        break;
      }
    }
  }

  const topicCountSkippedAfterRateLimit = rateLimitedAt
    ? urls.slice(urls.indexOf(rateLimitedAt) + 1).length
    : 0;

  return {
    sourceKind: "forum_topics",
    sourceId: "forum.zcashcommunity.com",
    sourceUrl: "https://forum.zcashcommunity.com",
    rawPayload: {
      fetchedAt,
      topicCountRequested: urls.length,
      topicCountSkippedConfigured: skippedTopicUrls.size,
      topicCountMirrored: records.length,
      topicCountFailed: failures.length,
      topicCountSkippedAfterRateLimit,
      maxTopics: maxTopicCount,
      maxPostsPerTopic: maxPostCount,
      fetchDelayMs: delayMs,
      rateLimitedAt,
      urls,
      failures
    },
    records,
    metadata: {
      fetchedAt,
      topicCountRequested: urls.length,
      topicCountSkippedConfigured: skippedTopicUrls.size,
      topicCountMirrored: records.length,
      topicCountFailed: failures.length,
      topicCountSkippedAfterRateLimit,
      maxTopics: maxTopicCount,
      maxPostsPerTopic: maxPostCount,
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
  const maxPostCount = maxPostsPerTopic(config);
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
  const urls = discoveredUrls.filter((url) => !skippedTopicUrls.has(url)).slice(0, maxTopicCount);
  const records: SourceMirrorRecord[] = [];

  for (const [index, url] of urls.entries()) {
    if (index > 0 && delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      const topic = await fetchForumTopic(url, maxPostCount);

      if (!topic) {
        topicFailures.push({ url, error: "Topic unavailable or not public." });
        continue;
      }

      records.push(
        topicRecord(topic, fetchedAt, {
          sourceKind: isMeetingMinutesTopic(topic.topic) ? "forum_meeting_minutes" : "forum_update_topic",
          mirrorKind: isMeetingMinutesTopic(topic.topic) ? "forum_meeting_minutes" : "forum_update_topic",
          metadata: {
            categorySourceUrl: categoryUrl,
            categorySourceKind: "forum_updates_category"
          }
        })
      );
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
      topicCountSelected: urls.length,
      topicCountSkippedConfigured: discoveredUrls.length - urls.length,
      topicCountMirrored: records.length,
      topicCountFailed: topicFailures.length,
      maxTopics: maxTopicCount,
      maxCategoryPages: maxPages,
      maxPostsPerTopic: maxPostCount,
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
      topicCountSelected: urls.length,
      topicCountSkippedConfigured: discoveredUrls.length - urls.length,
      topicCountMirrored: records.length,
      topicCountFailed: topicFailures.length,
      categoryFailureCount: categoryFailures.length,
      maxTopics: maxTopicCount,
      maxCategoryPages: maxPages,
      maxPostsPerTopic: maxPostCount,
      fetchDelayMs: delayMs,
      rateLimitedAt,
      recordCount: records.length
    }
  };
}
