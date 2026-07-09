import { forumTopicUrlsFromSourceRecords, mirrorForumTopics } from "./forum";
import { mirrorGitHubIssues } from "./github";
import { mirrorGoogleSheetTabs } from "./google-sheet";
import type { SourceMirrorEvent, SourceMirrorResult } from "./types";

export async function collectSourceMirrors(event: SourceMirrorEvent = {}): Promise<SourceMirrorResult[]> {
  const source = event.source ?? "phase1-all";

  if (source === "github-issues") {
    return [await mirrorGitHubIssues(event.github)];
  }

  if (source === "google-sheet") {
    return [await mirrorGoogleSheetTabs(event.googleSheet)];
  }

  if (source === "forum-topics") {
    return [await mirrorForumTopics(event.forum)];
  }

  if (source === "phase1-all" || source === "phase1") {
    const github = await mirrorGitHubIssues(event.github);
    const googleSheet = await mirrorGoogleSheetTabs(event.googleSheet);
    const forumUrls = forumTopicUrlsFromSourceRecords([...github.records, ...googleSheet.records]);
    const forum = await mirrorForumTopics({
      ...event.forum,
      urls: event.forum?.urls?.length ? event.forum.urls : forumUrls
    });

    return [github, googleSheet, forum];
  }

  throw new Error(`Unsupported Phase 1 mirror source: ${source}`);
}

export type { SourceMirrorEvent, SourceMirrorResult } from "./types";
