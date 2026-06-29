import { parse } from "csv-parse/sync";
import type {
  GoogleSheetMirrorConfig,
  GoogleSheetTabConfig,
  SourceMirrorRecord,
  SourceMirrorResult
} from "./types";

const DEFAULT_SHEET_ID = "1FQ28rDCyRW0TiNxrm3rgD8ai2KGUsXAjPieQmI1kKKg";
const DEFAULT_TABS: GoogleSheetTabConfig[] = [{ name: "default", gid: "803214474" }];

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
  const preferredKeys = ["Grant", "Project", "Title", "Name", "Applicant", "Organization"];

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
        headers,
        rowCount: rows.length
      }
    });

    rows.forEach((row, index) => {
      const rowNumber = index + 2;
      records.push({
        sourceKind: "google_sheet_row",
        sourceId: `${sheetId}:${tab.gid}:row:${rowNumber}`,
        sourceUrl: tabUrl,
        sourceUpdatedAt: null,
        title: titleFromRow(row, rowNumber),
        summary: rowSummary(row),
        rawPayload: row,
        metadata: {
          sheetId,
          tabName: tab.name,
          gid: tab.gid,
          rowNumber
        }
      });
    });

    rawTabs.push({
      name: tab.name,
      gid: tab.gid,
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
