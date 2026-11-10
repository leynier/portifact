// portifact search: finds artifacts whose text contains every word of a query, in your personal
// space or a workspace, as GET /api/v1/search answers it (premium plan T8, decision 0012). Admins
// and editors only, on a plan with content search: otherwise the API answers forbidden or
// plan_required. Snippets are text from the artifacts, printed as plain text.
import { SearchResults, type SearchSnippet } from "@portifact/contracts";
import { plain } from "./annotations.ts";
import { callApi } from "./api.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";
import { chosenWorkspace, workspaceQuery } from "./workspaces.ts";

export interface SearchOptions extends OutputOptions {
  workspace?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

/**
 * The snippet on one line with each highlight between « and ». The server already removed
 * control characters; bidi controls and line separators go here, and white space becomes spaces.
 */
export function markedSnippet(snippet: SearchSnippet): string {
  let out = "";
  let at = 0;
  for (const [start, end] of snippet.highlights) {
    if (start < at || end > snippet.text.length || start >= end) continue;
    out += `${snippet.text.slice(at, start)}«${snippet.text.slice(start, end)}»`;
    at = end;
  }
  // Marks first, so the ranges still index the server's text; then nothing a terminal would act
  // on (bidi controls, line separators) survives.
  return plain(out + snippet.text.slice(at))
    .replace(/\s+/g, " ")
    .trim();
}

export async function search(
  io: Io,
  runtime: Runtime,
  query: string,
  options: SearchOptions,
): Promise<void> {
  const session = await openSession(io, runtime);
  const params = new URLSearchParams({ q: query });
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  const workspace = await chosenWorkspace(session, options.workspace);
  const page = await callApi(session, {
    method: "GET",
    path: `/search${workspaceQuery(workspace, params)}`,
    schema: SearchResults,
  });
  if (options.json) {
    writeJson(io, page);
    return;
  }
  if (workspace !== undefined) io.stdout(`Workspace: ${workspace}\n`);
  if (page.items.length === 0) {
    io.stdout(`${messages.searchNoMatch}\n`);
    return;
  }
  for (const item of page.items) {
    const partial = item.partial ? ` ${messages.searchPartial}` : "";
    io.stdout(`${item.artifact.id}  ${plain(item.artifact.name)}  ${plain(item.path)}${partial}\n`);
    io.stdout(`  ${markedSnippet(item.snippet)}\n`);
  }
  if (page.nextCursor !== null) {
    const flags = workspace ? ` --workspace ${workspace}` : "";
    io.stderr(`${messages.searchMore(page.nextCursor, flags)}\n`);
  }
}
