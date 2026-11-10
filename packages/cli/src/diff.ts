// portifact diff: compare two versions of an artifact (premium plan P3). A thin call to the
// comparison API; the server decides access, the plan, retention and the diff itself, so this
// only follows the cursors and prints.
import {
  type DiffHunk,
  FileDiff,
  type FileDiff as FileDiffBody,
  VERSION_DIFF,
  VersionComparison,
} from "@portifact/contracts";
import { unifiedDiff } from "@portifact/domain";
import { callApi } from "./api.ts";
import { parseArtifactId, table } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { formatBytes, messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";
import { parseVersionArg, resolveVersionArg } from "./versions.ts";

export interface DiffOptions extends OutputOptions {
  /** A file to diff line by line instead of the file summary. */
  file?: string | undefined;
  /** The file is a private source rather than a published file. */
  source?: boolean;
}

export async function diff(
  io: Io,
  runtime: Runtime,
  id: string,
  from: string,
  to: string,
  options: DiffOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const fromArg = parseVersionArg(from);
  const toArg = parseVersionArg(to);
  const session = await openSession(io, runtime);
  const fromId = await resolveVersionArg(session, artifactId, fromArg);
  const toId = await resolveVersionArg(session, artifactId, toArg);
  const base = `/artifacts/${artifactId}/versions/${encodeURIComponent(fromId)}/diff/${encodeURIComponent(toId)}`;

  if (options.file !== undefined) {
    const kind = options.source ? "source" : "published";
    const hunks: DiffHunk[] = [];
    let cursor: number | null = 0;
    let result: FileDiffBody;
    do {
      const query = new URLSearchParams({ kind, path: options.file, cursor: String(cursor) });
      result = await callApi(session, {
        method: "GET",
        path: `${base}/file?${query}`,
        schema: FileDiff,
      });
      if (result.diff.status !== "text") break;
      hunks.push(...result.diff.hunks);
      cursor = result.diff.nextCursor;
    } while (cursor !== null);
    const whole: FileDiffBody =
      result.diff.status === "text"
        ? { ...result, diff: { ...result.diff, hunks, nextCursor: null } }
        : result;
    if (options.json) {
      writeJson(io, whole);
      return;
    }
    if (whole.diff.status !== "text") {
      io.stdout(
        `${messages.diffNoText(whole.path, whole.change, whole.diff.status, whole.before?.size ?? null, whole.after?.size ?? null)}\n`,
      );
      return;
    }
    io.stdout(
      unifiedDiff(hunks, {
        before: `a/${whole.path} (v${whole.from.number})`,
        after: `b/${whole.path} (v${whole.to.number})`,
      }),
    );
    return;
  }

  const files: VersionComparison["files"] = [];
  let cursor: string | null = null;
  let page: VersionComparison;
  do {
    const query = new URLSearchParams({ limit: String(VERSION_DIFF.filesMax) });
    if (cursor !== null) query.set("cursor", cursor);
    page = await callApi(session, {
      method: "GET",
      path: `${base}?${query}`,
      schema: VersionComparison,
    });
    files.push(...page.files);
    cursor = page.nextCursor;
  } while (cursor !== null);
  if (options.json) {
    writeJson(io, { ...page, files, nextCursor: null });
    return;
  }
  io.stdout(`${messages.diffSummary(artifactId, page.from.number, page.to.number, page.counts)}\n`);
  if (files.length === 0) return;
  const size = (file: { size: number } | null) => (file === null ? "-" : formatBytes(file.size));
  io.stdout(
    table([
      ["CHANGE", "KIND", "PATH", "BEFORE", "AFTER"],
      ...files.map((file) => [
        file.change,
        file.kind,
        file.path,
        size(file.before),
        size(file.after),
      ]),
    ]),
  );
}
