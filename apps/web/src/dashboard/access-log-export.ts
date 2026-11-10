// Export of the owner's access log from the dashboard (plan sections 6 and 13): the whole log,
// read page by page from the API like `portifact logs --json`, saved as JSON or CSV.
import { ACCESS_LOG, type AccessLogEntry, type AccessLogView } from "@portifact/contracts";
import type { DashboardApi } from "./api.ts";
import type { SavedFile } from "./publish/download.ts";

export type AccessLogFormat = "csv" | "json";

/** Every entry of the log, following the API's cursor to the end; the last page's metadata. */
export async function loadWholeAccessLog(
  api: Pick<DashboardApi, "accessLog">,
  artifactId: string,
): Promise<AccessLogView> {
  const entries: AccessLogEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await api.accessLog(artifactId, cursor, ACCESS_LOG.pageSize);
    entries.push(...page.entries);
    if (page.nextCursor === null) return { ...page, entries };
    // A cursor that does not move would page forever.
    if (page.nextCursor === cursor) throw new Error("The access log cursor did not advance.");
    cursor = page.nextCursor;
  }
}

// Spreadsheets run a cell that starts with one of these as a formula (CSV injection), and some
// strip a leading tab or carriage return before checking.
const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV field: neutralized against formulas, quoted when it holds a separator or a quote. */
export function csvField(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) || safe !== value ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The log as RFC 4180 CSV with a header row, in the API's order (newest first). */
export function accessLogCsv(entries: readonly AccessLogEntry[]): string {
  const rows = [
    ["openedAt", "email", "shareLink"],
    ...entries.map((entry) => [
      entry.openedAt,
      entry.email,
      entry.shareLink ? (entry.shareLink.label ?? entry.shareLink.id) : "",
    ]),
  ];
  return rows.map((row) => `${row.map(csvField).join(",")}\r\n`).join("");
}

/** The object `portifact logs --json` prints for the same log, indented. */
export function accessLogJson(log: AccessLogView): string {
  return `${JSON.stringify({ ...log, nextCursor: null }, null, 2)}\n`;
}

export async function exportAccessLog(
  api: Pick<DashboardApi, "accessLog">,
  artifactId: string,
  format: AccessLogFormat,
): Promise<SavedFile> {
  const log = await loadWholeAccessLog(api, artifactId);
  const fileName = `${artifactId}-access-log.${format}`;
  return format === "csv"
    ? { fileName, blob: new Blob([accessLogCsv(log.entries)], { type: "text/csv;charset=utf-8" }) }
    : { fileName, blob: new Blob([accessLogJson(log)], { type: "application/json" }) };
}
