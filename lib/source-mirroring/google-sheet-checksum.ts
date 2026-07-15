import { createHash } from "node:crypto";
import type { SourceMirrorResult } from "./types";

export const GOOGLE_SHEET_POLL_STATE_KEY =
  "source-mirrors/google-sheet-poll/last-success.json";
export const GOOGLE_SHEET_CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

export type GoogleSheetSuccessMarker = {
  schemaVersion: 1;
  checksum: string;
  committedAt: string;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }

  return value;
}

/**
 * Hashes only the durable Sheet content. Fetch timestamps are intentionally
 * excluded so an unchanged public export remains a cheap no-op.
 */
export function googleSheetContentChecksum(result: SourceMirrorResult) {
  if (result.sourceKind !== "google_sheet") {
    throw new Error("A Google Sheet mirror result is required to calculate its content checksum.");
  }

  const payload = result.rawPayload;
  const tabs = Array.isArray(payload.tabs) ? payload.tabs : [];

  if (!tabs.length || tabs.some((tab) => {
    if (!tab || typeof tab !== "object" || Array.isArray(tab)) {
      return true;
    }

    const manifest = tab as Record<string, unknown>;
    return typeof manifest.gid !== "string" ||
      !manifest.gid.trim() ||
      !Array.isArray(manifest.headers) ||
      !manifest.headers.length ||
      !Array.isArray(manifest.rows) ||
      !manifest.rows.length;
  })) {
    throw new Error("The Google Sheet poll returned an empty or incomplete tab export.");
  }

  const canonical = stableValue({
    sheetId: payload.sheetId ?? result.sourceId,
    tabs
  });

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export const googleSheetChecksumTestHooks = { stableValue };
