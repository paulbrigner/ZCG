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
  updatesCategoryUrl?: string;
  maxCategoryPages?: number;
  maxTopics?: number;
  maxPostsPerTopic?: number;
  fetchDelayMs?: number;
};

export type SourceMirrorEvent = {
  source?: string;
  github?: GitHubMirrorConfig;
  googleSheet?: GoogleSheetMirrorConfig;
  forum?: ForumMirrorConfig;
};
