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

  if (source === "phase1-all" || source === "phase1") {
    return [await mirrorGitHubIssues(event.github), await mirrorGoogleSheetTabs(event.googleSheet)];
  }

  throw new Error(`Unsupported Phase 1 mirror source: ${source}`);
}

export type { SourceMirrorEvent, SourceMirrorResult } from "./types";
