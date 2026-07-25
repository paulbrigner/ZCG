import crypto from "node:crypto";
import { parse } from "csv-parse/sync";
import type {
  GoogleSheetMirrorConfig,
  GoogleSheetTabConfig,
  SourceMirrorRecord,
  SourceMirrorResult
} from "./types";

const DEFAULT_SHEET_ID = "1FQ28rDCyRW0TiNxrm3rgD8ai2KGUsXAjPieQmI1kKKg";
const ALL_GRANTS_TAB_NAME = "all_grants_tracking";
const DEFAULT_TABS: GoogleSheetTabConfig[] = [
  {
    name: ALL_GRANTS_TAB_NAME,
    gid: "1164534734",
    rowIdentity: "grant_platform_link"
  },
  {
    name: "milestone_details",
    gid: "803214474",
    rowIdentity: "sheet_row_location"
  }
];
const GRANT_PLATFORM_LINK_FIELD = "Grant Platform Link";

function normalizedHeader(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function rowField(row: Record<string, string>, field: string) {
  const expected = normalizedHeader(field);
  const entry = Object.entries(row).find(([key]) => normalizedHeader(key) === expected);
  return entry?.[1]?.trim() ?? "";
}

function rowIdentityForTab(
  tab: GoogleSheetTabConfig
): NonNullable<GoogleSheetTabConfig["rowIdentity"]> {
  if (tab.rowIdentity) {
    return tab.rowIdentity;
  }

  // Preserve the existing environment-variable format while binding stable
  // identity to the configured All Grants dataset, not to incidental headers.
  return normalizedHeader(tab.name) === normalizedHeader(ALL_GRANTS_TAB_NAME)
    ? "grant_platform_link"
    : "sheet_row_location";
}

/**
 * Grant Platform Link is treated as an opaque business identifier. Trimming
 * and a trailing-slash normalization avoid accidental identity churn without
 * applying URL semantics to legacy values such as "NA".
 */
export function normalizeGrantPlatformIdentifier(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function grantPlatformSourceId(
  sheetId: string,
  gid: string,
  businessIdentifier: string
) {
  const digest = crypto
    .createHash("sha256")
    .update(normalizeGrantPlatformIdentifier(businessIdentifier))
    .digest("hex");
  return `${sheetId}:${gid}:grant-platform:${digest}`;
}

function configuredTabs(config?: GoogleSheetMirrorConfig): GoogleSheetTabConfig[] {
  if (config?.tabs?.length) {
    return config.tabs;
  }

  const rawTabs = process.env.ZCG_GOOGLE_SHEET_TABS;

  if (!rawTabs) {
    return DEFAULT_TABS;
  }

  return rawTabs
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, gid] = entry.includes(":") ? entry.split(":") : [entry, entry];
      return { name: name.trim(), gid: gid.trim() };
    });
}

function titleFromRow(row: Record<string, string>, rowNumber: number) {
  const preferredKeys = ["Proposal Title", "Grant", "Project", "Title", "Name", "Applicant", "Applicant(s)", "Organization"];

  for (const key of preferredKeys) {
    if (row[key]) {
      return row[key];
    }
  }

  const firstValue = Object.values(row).find((value) => value.trim().length > 0);
  return firstValue ? firstValue.slice(0, 160) : `Row ${rowNumber}`;
}

function rowSummary(row: Record<string, string>) {
  return Object.entries(row)
    .filter(([, value]) => value.trim().length > 0)
    .slice(0, 6)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" | ")
    .slice(0, 300);
}

async function fetchTabCsv(sheetId: string, tab: GoogleSheetTabConfig) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/export`);
  url.searchParams.set("format", "csv");
  url.searchParams.set("gid", tab.gid);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Google Sheet tab mirror failed for ${tab.name}: ${response.status} ${response.statusText}`);
  }

  const csv = await response.text();

  if (csv.trimStart().startsWith("<")) {
    throw new Error(`Google Sheet tab ${tab.name} did not return CSV. Confirm sharing/export access.`);
  }

  return csv;
}

export async function mirrorGoogleSheetTabs(
  config: GoogleSheetMirrorConfig = {}
): Promise<SourceMirrorResult> {
  const sheetId = config.sheetId ?? process.env.ZCG_GOOGLE_SHEET_ID ?? DEFAULT_SHEET_ID;
  const tabs = configuredTabs(config);
  const fetchedAt = new Date().toISOString();
  const records: SourceMirrorRecord[] = [];
  const rawTabs: Record<string, unknown>[] = [];

  for (const tab of tabs) {
    const csv = await fetchTabCsv(sheetId, tab);
    const rows = parse(csv, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true
    }) as Record<string, string>[];

    const headers = rows[0] ? Object.keys(rows[0]) : [];
    const tabUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit?gid=${tab.gid}`;
    const rowIdentity = rowIdentityForTab(tab);
    const hasGrantPlatformLinkHeader = headers.some(
      (header) => normalizedHeader(header) === normalizedHeader(GRANT_PLATFORM_LINK_FIELD)
    );
    const businessIdentifierRows = new Map<string, number>();

    if (rowIdentity === "grant_platform_link" && !hasGrantPlatformLinkHeader) {
      throw new Error(
        `Google Sheet tab ${tab.name} is configured to use ${GRANT_PLATFORM_LINK_FIELD} identity, ` +
        "but that column is missing."
      );
    }

    if (rowIdentity === "grant_platform_link") {
      rows.forEach((row, index) => {
        const rowNumber = index + 2;
        const identifier = normalizeGrantPlatformIdentifier(
          rowField(row, GRANT_PLATFORM_LINK_FIELD)
        );

        if (!identifier) {
          throw new Error(
            `Google Sheet tab ${tab.name} row ${rowNumber} is missing ${GRANT_PLATFORM_LINK_FIELD}; ` +
            "refusing to fall back to a mutable row-number identity."
          );
        }

        const existingRowNumber = businessIdentifierRows.get(identifier);
        if (existingRowNumber !== undefined) {
          throw new Error(
            `Google Sheet tab ${tab.name} has duplicate ${GRANT_PLATFORM_LINK_FIELD} ` +
            `values at rows ${existingRowNumber} and ${rowNumber}; refusing an ambiguous mirror.`
          );
        }

        businessIdentifierRows.set(identifier, rowNumber);
      });
    }

    records.push({
      sourceKind: "google_sheet_tab",
      sourceId: `${sheetId}:${tab.gid}`,
      sourceUrl: tabUrl,
      sourceUpdatedAt: null,
      title: tab.name,
      summary: `${rows.length} exported rows`,
      rawPayload: {
        sheetId,
        tab,
        headers,
        rowCount: rows.length
      },
      metadata: {
        sheetId,
        tabName: tab.name,
        gid: tab.gid,
        rowIdentity,
        headers,
        rowCount: rows.length
      }
    });

    rows.forEach((row, index) => {
      const rowNumber = index + 2;
      const rowLocationSourceId = `${sheetId}:${tab.gid}:row:${rowNumber}`;
      const rawBusinessIdentifier = rowIdentity === "grant_platform_link"
        ? rowField(row, GRANT_PLATFORM_LINK_FIELD)
        : "";
      const businessIdentifier = rawBusinessIdentifier
        ? normalizeGrantPlatformIdentifier(rawBusinessIdentifier)
        : null;
      records.push({
        sourceKind: "google_sheet_row",
        sourceId: businessIdentifier
          ? grantPlatformSourceId(sheetId, tab.gid, businessIdentifier)
          : rowLocationSourceId,
        sourceUrl: tabUrl,
        sourceUpdatedAt: null,
        title: titleFromRow(row, rowNumber),
        summary: rowSummary(row),
        rawPayload: row,
        metadata: {
          sheetId,
          tabName: tab.name,
          gid: tab.gid,
          rowNumber,
          rowLocationSourceId,
          identityStrategy: businessIdentifier
            ? "grant_platform_link"
            : "sheet_row_location",
          ...(businessIdentifier
            ? {
                businessIdentifierField: GRANT_PLATFORM_LINK_FIELD,
                businessIdentifier,
                businessIdentifierRaw: rawBusinessIdentifier
              }
            : {})
        }
      });
    });

    rawTabs.push({
      name: tab.name,
      gid: tab.gid,
      rowIdentity,
      rowCount: rows.length,
      headers,
      rows
    });
  }

  return {
    sourceKind: "google_sheet",
    sourceId: sheetId,
    sourceUrl: `https://docs.google.com/spreadsheets/d/${sheetId}`,
    rawPayload: {
      fetchedAt,
      sheetId,
      tabs: rawTabs
    },
    records,
    metadata: {
      fetchedAt,
      sheetId,
      tabCount: tabs.length,
      recordCount: records.length
    }
  };
}
