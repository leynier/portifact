// The export file of an artifact's data (decision 0026, "Export"), assembled in the browser from
// the export pages the API answers, like `portifact data export` writes it: a header with the
// collections, one JSON line per document with its body spliced in exactly as stored, and a
// footer that says whether every page saw the same revision. Nothing is archived on the server.
import type { DataExportPageView } from "@portifact/contracts";
import { escapeControls, exportConsistent } from "@portifact/domain";
import { exportFooter, exportHeader, exportLine } from "@portifact/domain/artifact-data";

/** The most pages one export reads: far above any plan's data, so a loop always ends. */
export const DATA_EXPORT_MAX_PAGES = 10_000;

export interface DataExportFile {
  text: string;
  documents: number;
  consistent: boolean;
}

/** Reads every page after the first and builds the JSON Lines file. */
export async function buildDataExport(
  artifactId: string,
  read: (after?: string) => Promise<DataExportPageView>,
): Promise<DataExportFile> {
  const first = await read();
  const header = first.header ?? { generation: 0, revision: first.revision, collections: [] };
  const revisions = [header.revision, first.revision];
  const lines: string[] = [];
  let page = first;
  for (let count = 1; ; count += 1) {
    for (const row of page.rows) lines.push(escapeControls(exportLine(row)));
    if (page.next === null) break;
    if (count >= DATA_EXPORT_MAX_PAGES) throw new Error("The export did not end");
    page = await read(page.next);
    revisions.push(page.revision);
  }
  const consistent = exportConsistent(revisions);
  const end = page.revision;
  const text =
    exportHeader({
      artifact: artifactId,
      generation: header.generation,
      revision: header.revision,
      collections: header.collections,
    }) +
    lines.join("") +
    // The footer's flag covers every page and the description, not only the first and last.
    exportFooter(consistent ? end : end + 1, end, lines.length);
  return { text, documents: lines.length, consistent };
}
