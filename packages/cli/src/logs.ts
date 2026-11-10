// portifact logs: the signed-in visitors who opened one of your artifacts, as
// GET /api/v1/artifacts/:id/access-log reports them (plan section 6). The server keeps them for
// the owner plan's retention (30 days on free) and records one entry per visitor every 30
// minutes; this follows the cursor to the last page.
import { type AccessLogEntry, AccessLogView } from "@portifact/contracts";
import { plain } from "./annotations.ts";
import { callApi } from "./api.ts";
import { parseArtifactId, table } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { formatDate, messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";

/** Entries asked for per request: the API's largest page. */
const PAGE_SIZE = 100;

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * `--since` as the API's ISO date: a duration back from now (`30m`, `12h`, `7d`) or an ISO date
 * and time in UTC.
 */
export function parseSince(value: string, now: number): string {
  const trimmed = value.trim();
  const relative = /^([0-9]{1,4})([mhd])$/.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]) * UNIT_MS[relative[2] as keyof typeof UNIT_MS];
    return new Date(now - amount).toISOString();
  }
  const at = Date.parse(trimmed);
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed) || Number.isNaN(at)) {
    throw new CliError("invalid_input", messages.errors.invalidSince(value));
  }
  return new Date(at).toISOString();
}

export interface LogsOptions extends OutputOptions {
  since?: string | undefined;
}

export async function logs(
  io: Io,
  runtime: Runtime,
  id: string,
  options: LogsOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const since = options.since === undefined ? undefined : parseSince(options.since, runtime.now());
  const session = await openSession(io, runtime);
  const entries: AccessLogEntry[] = [];
  let cursor: string | null = null;
  let page: AccessLogView;
  do {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor !== null) query.set("cursor", cursor);
    if (since !== undefined) query.set("since", since);
    page = await callApi(session, {
      method: "GET",
      path: `/artifacts/${artifactId}/access-log?${query}`,
      schema: AccessLogView,
    });
    entries.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor !== null);

  if (options.json) {
    writeJson(io, { ...page, entries, nextCursor: null });
    return;
  }
  if (entries.length === 0) {
    io.stdout(`${messages.logsEmpty(artifactId, page.retentionDays)}\n`);
  } else {
    io.stdout(
      table([
        ["OPENED", "VISITOR"],
        ...entries.map((entry) => [
          formatDate(entry.openedAt),
          entry.shareLink
            ? messages.logsShareLink(plain(entry.shareLink.label ?? entry.shareLink.id))
            : entry.email,
        ]),
      ]),
    );
  }
  io.stdout(`${messages.logsNote(page.windowMinutes, page.retentionDays)}\n`);
}
