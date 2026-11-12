// The export (decision 0026, "Export"): pages in primary key order after a cursor, bounded in rows
// and bytes, each with the payload revision; and the JSON Lines file the CLI and the dashboard
// write from them. A line's `body` is the stored text spliced in as it is, so the file holds every
// body exactly as stored, without a parse and serialize round trip.
import {
  ARTIFACT_DATA,
  DATA_EXPORT_FORMAT,
  DATA_EXPORT_VERSION,
  DataExportFooter,
  DataExportHeader,
  DataExportRow,
  type ExportCursor,
} from "@portifact/contracts/artifact-data";
import { accept, type Decision, refuse } from "./decision.ts";
import { utf8Length } from "./documents.ts";

/** One stored document, as an export page carries it: its server fields and its stored body. */
export interface ExportDocument {
  collection: string;
  id: string;
  by: string;
  editedBy: string | null;
  created: number;
  updated: number;
  /** The body's stored JSON text. */
  body: string;
}

/** One line of the file for a document, ending in a newline. */
export function exportLine(document: ExportDocument): string {
  const head = JSON.stringify({
    collection: document.collection,
    id: document.id,
    by: document.by,
    editedBy: document.editedBy,
    created: document.created,
    updated: document.updated,
  });
  return `${head.slice(0, -1)},"body":${document.body}}\n`;
}

/** Whether `a` comes before `b` in primary key order (collection, then ID). */
export function keyBefore(a: ExportCursor, b: ExportCursor): boolean {
  return a.collection < b.collection || (a.collection === b.collection && a.id < b.id);
}

export interface ExportPage {
  rows: ExportDocument[];
  next: ExportCursor | null;
  revision: number;
  bytes: number;
}

/**
 * Cuts a page from the rows read after the cursor, in primary key order: at most `take` rows and
 * at most `exportBytes` of encoded lines, except that a single row over the byte cap still makes a
 * page of one. `next` is the last row's key when rows were left.
 */
export function cutPage(
  candidates: Iterable<ExportDocument>,
  take: number,
  revision: number,
): ExportPage {
  const limit = Math.min(Math.max(Math.trunc(take), 1), ARTIFACT_DATA.caps.exportRows);
  const rows: ExportDocument[] = [];
  let bytes = 0;
  let cut = false;
  for (const row of candidates) {
    const size = utf8Length(exportLine(row));
    if (
      rows.length >= limit ||
      (rows.length > 0 && bytes + size > ARTIFACT_DATA.caps.exportBytes)
    ) {
      cut = true;
      break;
    }
    rows.push(row);
    bytes += size;
  }
  const last = rows.at(-1);
  return {
    rows,
    next: cut && last !== undefined ? { collection: last.collection, id: last.id } : null,
    revision,
    bytes,
  };
}

/** The file's first line. */
export function exportHeader(input: {
  artifact: string;
  generation: number;
  revision: number;
  collections: DataExportHeader["collections"];
}): string {
  const header: DataExportHeader = {
    format: DATA_EXPORT_FORMAT,
    version: DATA_EXPORT_VERSION,
    artifact: input.artifact,
    generation: input.generation,
    revision: input.revision,
    collections: input.collections,
  };
  return `${JSON.stringify(header)}\n`;
}

/**
 * The file's last line. The export is a consistent snapshot when the revision at its end is the
 * one its header recorded: the revision changes only when documents change.
 */
export function exportFooter(
  startRevision: number,
  endRevision: number,
  documents: number,
): string {
  const footer: DataExportFooter = {
    footer: true,
    revision: endRevision,
    consistent: startRevision === endRevision,
    documents,
  };
  return `${JSON.stringify(footer)}\n`;
}

export interface ExportFile {
  header: DataExportHeader;
  rows: DataExportRow[];
  footer: DataExportFooter;
}

/**
 * Reads a file back: a header of a version this code knows, document lines in strictly increasing
 * primary key order, and a footer whose count matches. Fields a later version adds are ignored; a
 * later version is refused, since it may have changed a field's meaning.
 */
export function parseExportFile(text: string): Decision<ExportFile> {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const parsed: unknown[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      return refuse("invalid_input", "every line of an export is JSON");
    }
  }
  const header = DataExportHeader.safeParse(parsed[0]);
  if (!header.success) return refuse("invalid_input", "the export has no valid header");
  if (header.data.version > DATA_EXPORT_VERSION) {
    return refuse(
      "invalid_input",
      `export version ${header.data.version} is newer than this reader`,
    );
  }
  const footer = DataExportFooter.safeParse(parsed.at(-1));
  if (parsed.length < 2 || !footer.success) {
    return refuse("invalid_input", "the export is incomplete");
  }
  const rows: DataExportRow[] = [];
  for (const item of parsed.slice(1, -1)) {
    const row = DataExportRow.safeParse(item);
    if (!row.success) return refuse("invalid_input", "the export has an invalid document line");
    const previous = rows.at(-1);
    if (previous !== undefined && !keyBefore(previous, row.data)) {
      return refuse("invalid_input", "the export's documents are out of order");
    }
    rows.push(row.data);
  }
  if (footer.data.documents !== rows.length) {
    return refuse("invalid_input", "the export is incomplete");
  }
  return accept({ header: header.data, rows, footer: footer.data });
}
