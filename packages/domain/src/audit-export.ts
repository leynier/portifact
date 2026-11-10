// Exporting the audit log (premium plan E3, feature `auditExport`): how one event becomes a CSV
// row or a JSON Lines line, and where one export request stops. The services read and present
// the events; these functions only decide bytes and bounds, so every interface writes the same
// file for the same rows.
import {
  AUDIT_CSV_COLUMNS,
  type AuditEventView,
  type AuditExportFormat,
  type AuditFilters,
} from "@portifact/contracts";
import type { AuditPosition } from "./audit.ts";

/** Lines end with CRLF in CSV (RFC 4180) and LF in JSON Lines. */
const CRLF = "\r\n";

/**
 * Characters that make a spreadsheet read a cell as a formula (or, for tab and carriage return,
 * hide one). A cell that starts with one gets a leading apostrophe, which spreadsheets show as
 * text and never run; the cell's value is otherwise unchanged.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: neutralized against formulas, then quoted when RFC 4180 requires it. */
export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function csvLine(cells: readonly string[]): string {
  return `${cells.map(csvCell).join(",")}${CRLF}`;
}

/** The CSV header line, written once at the start of an export (never on a resumed part). */
export function auditCsvHeader(): string {
  return csvLine(AUDIT_CSV_COLUMNS);
}

/** What the export names as the actor: a member's name or a token's label, never an address. */
function actorCells(actor: AuditEventView["actor"]): [string, string, string] {
  switch (actor.type) {
    case "member":
      return [actor.type, actor.id, actor.name];
    case "removed_member":
      return [actor.type, actor.id, ""];
    case "service_token":
    case "directory":
      return [actor.type, actor.id, actor.label ?? ""];
    case "operator":
    case "system":
      return [actor.type, "", ""];
  }
}

/** One event as a CSV line, in the order of `AUDIT_CSV_COLUMNS`. */
export function auditCsvRow(event: AuditEventView): string {
  return csvLine([
    event.id,
    event.at,
    event.kind,
    ...actorCells(event.actor),
    event.target.type,
    event.target.id ?? "",
    event.artifact?.id ?? "",
    event.artifact?.name ?? "",
    JSON.stringify(event.detail),
  ]);
}

/** One event as a JSON Lines line: the same object the API and MCP return. */
export function auditJsonLine(event: AuditEventView): string {
  return `${JSON.stringify(event)}\n`;
}

/** One event in the export's format. */
export function auditExportLine(format: AuditExportFormat, event: AuditEventView): string {
  return format === "csv" ? auditCsvRow(event) : auditJsonLine(event);
}

/** What starts an export's first part: the CSV header, nothing for JSON Lines. */
export function auditExportPreamble(format: AuditExportFormat): string {
  return format === "csv" ? auditCsvHeader() : "";
}

/** The fixed name of the downloaded file. */
export function auditExportFileName(format: AuditExportFormat): string {
  return `portifact-audit.${format}`;
}

/** The media type of each format. */
export function auditExportContentType(format: AuditExportFormat): string {
  return format === "csv"
    ? "text/csv; charset=utf-8; header=present"
    : "application/jsonl; charset=utf-8";
}

/** Newest first: the order of the log, by time and then ID. */
export function newerFirst(x: AuditPosition, y: AuditPosition): number {
  return y.at - x.at || (y.id < x.id ? -1 : y.id > x.id ? 1 : 0);
}

/**
 * Where one export request stops. Each database reports the position of its `perDatabase`-th
 * row after the cursor (null when it has fewer), and the request stops at the newer of the two,
 * inclusive: each database then gives at most `perDatabase` rows, and the database that set the
 * stop gives exactly that many, so every part makes progress. Null means the rest fits.
 */
export function auditExportStop(
  boundaries: readonly (AuditPosition | null)[],
): AuditPosition | null {
  const found = boundaries.filter((b): b is AuditPosition => b !== null);
  if (found.length === 0) return null;
  return [...found].sort(newerFirst)[0] as AuditPosition;
}

/**
 * The `audit.exported` detail of an export's filters: the format, how many kinds (0 for all) and
 * the date range as ISO dates, never the actor or target it filtered on.
 */
export function auditExportDetail(
  format: AuditExportFormat,
  filters: AuditFilters,
): { format: AuditExportFormat; kinds: number; from?: string; to?: string } {
  return {
    format,
    kinds: filters.kinds?.length ?? 0,
    ...(filters.from ? { from: filters.from.slice(0, 10) } : {}),
    ...(filters.to ? { to: filters.to.slice(0, 10) } : {}),
  };
}
