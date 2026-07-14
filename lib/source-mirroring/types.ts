export type SourceMirrorRecord = {
  sourceKind: string;
  sourceId: string;
  sourceUrl?: string;
  sourceUpdatedAt?: string | null;
  title?: string | null;
  summary?: string | null;
  rawPayload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type SourceMirrorResult = {
  sourceKind: string;
  sourceId: string;
  sourceUrl?: string;
  rawPayload: Record<string, unknown>;
  records: SourceMirrorRecord[];
  metadata?: Record<string, unknown>;
};

export type GitHubMirrorConfig = {
  owner?: string;
  repo?: string;
  token?: string;
  /** One-based issue-list page at which this mirror invocation should begin. */
  startPage?: number;
  /** Number of GitHub issue-list entries requested per page (maximum 100). */
  pageSize?: number;
  /** Maximum number of issue-list pages to include, starting at startPage. */
  maxPages?: number;
  commentMaxPages?: number;
};

export type GoogleSheetTabConfig = {
  name: string;
  gid: string;
};

export type GoogleSheetMirrorConfig = {
  sheetId?: string;
  tabs?: GoogleSheetTabConfig[];
};

export type ForumMirrorConfig = {
  urls?: string[];
  skipUrls?: string[];
  skipExistingSourceRecords?: boolean;
  /** Discover update-category topic URLs without fetching individual topic bodies. Ignored in direct URL mode. */
  discoveryOnly?: boolean;
  updatesCategoryUrl?: string;
  maxCategoryPages?: number;
  maxTopics?: number;
  maxPostsPerLinkedTopic?: number;
  maxPostsPerUpdatesTopic?: number;
  /** @deprecated Use the source-specific post limits instead. */
  maxPostsPerTopic?: number;
  fetchDelayMs?: number;
};

export type SourceMirrorEvent = {
  source?: string;
  github?: GitHubMirrorConfig;
  googleSheet?: GoogleSheetMirrorConfig;
  forum?: ForumMirrorConfig;
};
