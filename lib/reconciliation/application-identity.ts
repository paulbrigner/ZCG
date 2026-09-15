import { createHash } from "node:crypto";
import { normalizeGrantPlatformIdentifier } from "../source-mirroring/google-sheet";

export type ExistingHistoricalApplicationIdentity = {
  canonical_key: string;
  platform_link: string | null;
  created_at: string;
  updated_at: string;
  manual_decisions: number | string;
};

export function normalizedGitHubIssueUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/?$/);
    if (!match || url.hostname.toLowerCase() !== "github.com" || !["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    return `https://github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/issues/${match[3]}`;
  } catch {
    return null;
  }
}

export function applicationPlatformIdentity(value: string | null): string | null {
  if (!value?.trim()) return null;
  // An issue-comment fragment is evidence within the same GitHub application.
  // Other platforms, including opaque legacy identifiers, keep the mirror's
  // identity contract; do not infer equivalence from a similar title.
  return normalizedGitHubIssueUrl(value) ?? normalizeGrantPlatformIdentifier(value);
}

export function historicalIdentityKey(platformLink: string | null, sourceId: string): string {
  const identity = applicationPlatformIdentity(platformLink);
  return `${identity ? "platform" : "source"}:${createHash("sha256")
    .update(identity ?? sourceId)
    .digest("hex")}`;
}

export function existingHistoricalKeysByPlatform(rows: ExistingHistoricalApplicationIdentity[]): Map<string, string> {
  const candidates = new Map<string, ExistingHistoricalApplicationIdentity[]>();
  for (const row of rows) {
    const identity = applicationPlatformIdentity(row.platform_link);
    if (!identity) continue;
    candidates.set(identity, [...(candidates.get(identity) ?? []), row]);
  }

  const keys = new Map<string, string>();
  for (const [identity, entries] of candidates) {
    const reviewed = entries.filter((row) => Number(row.manual_decisions) > 0);
    if (reviewed.length > 1) {
      throw new Error(`Application identity ${identity} has multiple records with active manual decisions; reconcile those identities before rebuilding.`);
    }
    const ordered = [...entries].sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at) ||
      left.created_at.localeCompare(right.created_at) ||
      left.canonical_key.localeCompare(right.canonical_key)
    );
    keys.set(identity, (reviewed[0] ?? ordered[0]).canonical_key);
  }
  return keys;
}
