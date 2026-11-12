// portifact export: everything a space holds, into a folder (decision 0022, second delivery).
// Every artifact and every retained version through the version download route (published files
// and, when there are any, the private sources), each artifact's access log, its records
// (`records.json`: settings, access rules, share link settings, the approval review, analytics,
// comment threads and their action history), the space's records (`space.json`) and the space's
// audit log when the caller may read them, and `manifest.json`, written last, describing what is
// there. It only uses read routes other commands use: the server never builds an archive. What
// only the dashboard's session may read (members, invitations, email domains, service tokens,
// branding and the like) is marked `dashboard_only` in `space.json`.
//
// The folder is handled by `SafeFolder`: nothing is written through a link, every file goes
// through a temporary file of its own and counts only once read back from its place with the
// right size and SHA-256. A lock file keeps two exports out of one folder, and the folder's marker
// names the owner, so another space's export is never mixed in. A second run keeps what is
// complete and verified and fetches the rest. Something the caller may not read, or that went
// away while the export ran, is recorded as skipped; something the server asked to retry later
// (a rate limit) makes the export exit 1 with everything else written, so running it again
// completes it.
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  AccessLogView,
  AccessPolicyView,
  ANNOTATION_HISTORY_PAGE,
  AnnotationExport,
  AnnotationHistoryPage,
  ApprovalReviewView,
  ArtifactList,
  type ArtifactListItem,
  ArtifactRecords,
  ArtifactStatsView,
  ArtifactSummary,
  AUDIT_EXPORT_CURSOR_HEADER,
  type DownloadKind,
  type DownloadLink,
  EXPORT_MANIFEST_FILE,
  EXPORT_MANIFEST_FORMAT,
  type ExportedFile,
  type ExportedLog,
  type ExportedRecordFile,
  type ExportedVersion,
  ExportManifest,
  type ExportSkipReason,
  GraceForecastView,
  ShareLinkList,
  type SkippedRecord,
  SpaceRecords,
  VersionList,
  type VersionSummary,
  WebhookList,
  WorkspaceGroupList,
  WorkspaceList,
} from "@portifact/contracts";
import {
  collectArtifactRecords,
  collectSpaceRecords,
  exportPathSegments,
  exportVersionFolder,
  isGitSegment,
  type RecordPart,
  recordsRetryLater,
} from "@portifact/domain";
import { type ZodType, z } from "zod";
import { callApi, downloadApi, RETRY_ATTEMPTS, withRetries } from "./api.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError, EXIT } from "./errors.ts";
import { EXPORT_LOCK, takeExportLock } from "./export-lock.ts";
import { messages } from "./messages.ts";
import { checkDownloadPaths, DOWNLOAD_CONCURRENCY, fetchLinks } from "./pull.ts";
import type { Io, Runtime } from "./runtime.ts";
import { SafeFolder, TEMP_FOLDER } from "./safe-folder.ts";
import type { Session } from "./session.ts";
import { URL_EXPIRY_MARGIN_MS } from "./upload.ts";
import { chosenWorkspace, workspaceQuery } from "./workspaces.ts";

/** The file that marks a folder as an export of one owner. */
export const EXPORT_MARKER = ".portifact-export";
/** The records an unfinished export already wrote and verified (see `readJournal`). */
export const RECORDS_JOURNAL = ".portifact-export-records.json";
const PAGE = 100;
const RETRY_BASE_MS = 1_000;

export interface ExportOptions extends OutputOptions {
  workspace?: string | undefined;
  dryRun: boolean;
  /** For tests: whether to apply Windows' file name rules (defaults to the platform's). */
  windows?: boolean | undefined;
}

interface Planned {
  artifact: ArtifactListItem;
  versions: VersionSummary[];
  skipped?: ExportSkipReason;
}

/** Refusals that mean "not there to export" (or "not now") rather than a failure. */
function skipReason(error: unknown): ExportSkipReason | null {
  if (!(error instanceof CliError)) return null;
  if (
    error.code === "forbidden" ||
    error.code === "plan_required" ||
    error.code === "not_found" ||
    error.code === "rate_limited"
  ) {
    return error.code;
  }
  return null;
}

/** Answers the exit code: 0 when complete, 1 when a part must be fetched again later. */
export async function exportSpace(
  io: Io,
  runtime: Runtime,
  folder: string,
  options: ExportOptions,
): Promise<number> {
  const out = resolve(folder);
  if (out.split(sep).some(isGitSegment)) {
    throw new CliError("invalid_input", messages.errors.outInsideGit(out));
  }
  const session = await openSession(io, runtime);
  const workspace =
    options.workspace === undefined ? undefined : await chosenWorkspace(session, options.workspace);
  const space = workspace ?? "personal";
  const forecast = await callApi(session, {
    method: "GET",
    path: `/grace-forecast${workspaceQuery(workspace)}`,
    schema: GraceForecastView,
  });
  const planned = await planExport(session, workspace);
  const live = planned.filter((item) => item.skipped === undefined);
  const versions = live.reduce((sum, item) => sum + item.versions.length, 0);
  const sum = (pick: (version: VersionSummary) => number) =>
    live.reduce((total, item) => total + item.versions.reduce((v, x) => v + pick(x), 0), 0);
  const bytes = sum((v) => v.publishedBytes + v.sourceBytes);
  const files = sum((v) => v.publishedFiles + v.sourceFiles);

  if (options.dryRun) {
    const grace = forecast.grace ? forecast : null;
    if (options.json) {
      writeJson(io, {
        dryRun: true,
        space,
        out,
        artifacts: live.length,
        versions,
        files,
        bytes,
        grace,
      });
      return EXIT.ok;
    }
    io.stdout(`${messages.exportSpace.dryRun(space, live.length, versions, files, bytes, out)}\n`);
    for (const kind of grace?.kinds ?? []) {
      io.stdout(`${messages.exportSpace.goes(kind.kind, kind.count, kind.from)}\n`);
    }
    return EXIT.ok;
  }

  const target = await SafeFolder.open(out);
  // The lock first: nothing in the folder is read or written before this run holds it.
  const lock = await takeExportLock(target.root, out, runtime.processAlive);
  // Ctrl-C or `kill`: the lock goes, so running the command again resumes (130 and 143, the
  // shell's codes for a process stopped by SIGINT and SIGTERM).
  const stopListening = runtime.onSignal((signal) => {
    lock.releaseNow();
    io.stderr(`${messages.exportSpace.stopped(out)}\n`);
    runtime.exit(signal === "SIGINT" ? 130 : 143);
  });
  try {
    await claimFolder(target, forecast.ownerId, out);
    return await writeExport(io, session, target, out, planned, {
      workspace,
      space,
      ownerId: forecast.ownerId,
      windows: options.windows ?? process.platform === "win32",
      json: options.json === true,
    });
  } finally {
    stopListening();
    await lock.release();
  }
}

/**
 * Claims the folder for this run, which holds its lock: refused when it holds anything but an
 * earlier export of this same owner (its marker names the owner's ID). An earlier run's manifest
 * is removed, so a run that stops before its end leaves no manifest that seems to describe it:
 * a folder without `manifest.json` holds an unfinished export.
 */
async function claimFolder(folder: SafeFolder, ownerId: string, out: string): Promise<void> {
  const marker = await folder.readText([EXPORT_MARKER]);
  const entries = (await readdir(folder.root)).filter(
    (name) => name !== TEMP_FOLDER && name !== EXPORT_LOCK,
  );
  if (marker === null ? entries.length > 0 : markerOwner(marker) !== ownerId) {
    throw new CliError("invalid_input", messages.exportSpace.notAnExport(out));
  }
  await folder.clearTemporary();
  // A run that ended complete closes its export: the next run reads every record again. Without
  // a manifest (stopped) or with one that is not complete (exit 8), the next run resumes it.
  if (await finishedExport(folder)) await folder.remove([RECORDS_JOURNAL]);
  await folder.remove([EXPORT_MANIFEST_FILE]);
  if (marker === null) {
    await folder.writeText([EXPORT_MARKER], `${JSON.stringify({ ownerId })}\n`);
  }
}

/** Whether the folder's manifest is a readable one of a complete run. */
async function finishedExport(folder: SafeFolder): Promise<boolean> {
  const text = await folder.readText([EXPORT_MANIFEST_FILE]);
  if (text === null) return false;
  try {
    const manifest = ExportManifest.safeParse(JSON.parse(text));
    // A manifest this version cannot read was written by another one: start afresh.
    return manifest.success ? manifest.data.complete : true;
  } catch {
    return true;
  }
}

/**
 * The records an unfinished export already wrote, with the size and SHA-256 of each file, so a
 * resumed run keeps them instead of reading them again. A file counts only when its bytes at
 * their place still match; anything unreadable here is ignored.
 */
const RecordsJournal = z.object({
  records: z.record(z.string(), z.object({ size: z.number().int(), sha256: z.string() })),
});
type RecordsJournal = z.infer<typeof RecordsJournal>;

async function readJournal(folder: SafeFolder): Promise<RecordsJournal> {
  const text = await folder.readText([RECORDS_JOURNAL]);
  if (text === null) return { records: {} };
  try {
    const parsed = RecordsJournal.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : { records: {} };
  } catch {
    return { records: {} };
  }
}

function markerOwner(text: string): string | null {
  try {
    const value = JSON.parse(text) as { ownerId?: unknown };
    return typeof value.ownerId === "string" ? value.ownerId : null;
  } catch {
    return null;
  }
}

interface WriteContext {
  workspace: string | undefined;
  space: string;
  ownerId: string;
  windows: boolean;
  json: boolean;
}

async function writeExport(
  io: Io,
  session: Session,
  folder: SafeFolder,
  out: string,
  planned: Planned[],
  context: WriteContext,
): Promise<number> {
  const manifest: ExportManifest = {
    format: EXPORT_MANIFEST_FORMAT,
    space: context.space,
    ownerId: context.ownerId,
    exportedAt: new Date(session.runtime.now()).toISOString(),
    artifacts: [],
    audit: { skipped: "not_found" },
    spaceRecords: { skipped: "not_found" },
    totals: { artifacts: 0, versions: 0, files: 0, bytes: 0 },
    complete: false,
  };
  let recordsLater = false;
  const journal = await readJournal(folder);
  const total = planned.reduce((sum, item) => sum + item.versions.length, 0);
  let accessLogs: "allowed" | ExportSkipReason = "allowed";
  let done = 0;
  for (const item of planned) {
    const exported: ExportedVersion[] = [];
    let skipped = item.skipped;
    for (const version of skipped ? [] : item.versions) {
      try {
        exported.push(
          await exportVersion(io, session, folder, out, item.artifact.id, version, context.windows),
        );
      } catch (error) {
        // An artifact deleted or purged while the export ran, or a request the server asked to
        // retry later: what was written stays, the rest of it is recorded as skipped.
        const reason = skipReason(error);
        if (reason !== "not_found" && reason !== "rate_limited") throw error;
        skipped = reason;
        break;
      }
      done += 1;
      io.stderr(
        `${messages.exportSpace.progress(done, total, item.artifact.id, version.number)}\n`,
      );
    }
    let accessLog: ExportedLog;
    if (skipped === "not_found") {
      accessLog = { skipped: "not_found" };
    } else if (accessLogs === "allowed") {
      accessLog = await exportAccessLog(session, folder, item.artifact.id);
      // A role that may not read one artifact's access log reads none of the space's.
      if (
        "skipped" in accessLog &&
        (accessLog.skipped === "forbidden" || accessLog.skipped === "plan_required")
      ) {
        accessLogs = accessLog.skipped;
      }
    } else {
      accessLog = { skipped: accessLogs };
    }
    let records: ExportedRecordFile;
    if (skipped === "not_found") {
      records = { skipped: "not_found" };
    } else {
      const written = await exportArtifactRecords(session, folder, item.artifact.id, journal);
      recordsLater ||= written.retryLater;
      records = written.file;
    }
    manifest.artifacts.push({
      id: item.artifact.id,
      name: item.artifact.name,
      versions: exported,
      accessLog,
      records,
      ...(skipped ? { skipped } : {}),
    });
  }
  const space = await exportSpaceRecords(session, folder, context.workspace, context.ownerId);
  recordsLater ||= space.retryLater;
  manifest.spaceRecords = space.file;
  manifest.audit = await exportAudit(session, folder, context.workspace);
  const all = manifest.artifacts.flatMap((a) => a.versions.flatMap((v) => v.files));
  manifest.totals = {
    artifacts: manifest.artifacts.length,
    versions: manifest.artifacts.reduce((sum, a) => sum + a.versions.length, 0),
    files: all.length,
    bytes: all.reduce((sum, file) => sum + file.size, 0),
  };
  const skippedArtifacts = manifest.artifacts.filter((a) => a.skipped !== undefined);
  const logs = [...manifest.artifacts.map((a) => a.accessLog), manifest.audit];
  const retryLater =
    recordsLater ||
    [...manifest.artifacts.map((a) => a.records), manifest.spaceRecords].some(
      (file) => "skipped" in file && file.skipped === "rate_limited",
    ) ||
    skippedArtifacts.some((a) => a.skipped === "rate_limited") ||
    logs.some((log) => "skipped" in log && log.skipped === "rate_limited");
  manifest.complete = !retryLater;
  await folder.writeText(
    [EXPORT_MANIFEST_FILE],
    `${JSON.stringify(ExportManifest.parse(manifest), null, 2)}\n`,
  );
  // A complete export needs no journal: the next run reads every record again.
  if (manifest.complete) await folder.remove([RECORDS_JOURNAL]);
  if (context.json) {
    writeJson(io, {
      out,
      ...manifest.totals,
      complete: !retryLater,
      skipped: skippedArtifacts.map((a) => ({ id: a.id, reason: a.skipped })),
      audit: manifest.audit,
    });
  } else {
    const { artifacts, versions, files, bytes } = manifest.totals;
    io.stdout(
      `${messages.exportSpace.done(context.space, artifacts, versions, files, bytes, out)}\n`,
    );
    for (const artifact of skippedArtifacts) {
      io.stdout(
        `${messages.exportSpace.skipped(artifact.id, artifact.skipped as ExportSkipReason)}\n`,
      );
    }
    if ("skipped" in manifest.audit && manifest.audit.skipped === "rate_limited") {
      io.stdout(`${messages.exportSpace.auditLater}\n`);
    }
    io.stdout(
      `${context.workspace === undefined ? messages.exportSpace.dashboardOnlyPersonal : messages.exportSpace.dashboardOnly}\n`,
    );
    if (retryLater) io.stdout(`${messages.exportSpace.incomplete}\n`);
  }
  return retryLater ? EXIT.incomplete : EXIT.ok;
}

/** Every artifact of the space and its retained versions, a page at a time. */
async function planExport(session: Session, workspace: string | undefined): Promise<Planned[]> {
  const planned: Planned[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: String(PAGE) });
    if (cursor !== null) query.set("cursor", cursor);
    const page: ArtifactList = await withRetries(session, () =>
      callApi(session, {
        method: "GET",
        path: `/artifacts${workspaceQuery(workspace, query)}`,
        schema: ArtifactList,
      }),
    );
    for (const artifact of page.items) {
      try {
        planned.push({ artifact, versions: await versionsOf(session, artifact.id) });
      } catch (error) {
        const reason = skipReason(error);
        if (reason !== "not_found" && reason !== "rate_limited") throw error;
        planned.push({ artifact, versions: [], skipped: reason });
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return planned;
}

async function versionsOf(session: Session, artifactId: string): Promise<VersionSummary[]> {
  const versions: VersionSummary[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: String(PAGE) });
    if (cursor !== null) query.set("cursor", cursor);
    const page: VersionList = await withRetries(session, () =>
      callApi(session, {
        method: "GET",
        path: `/artifacts/${artifactId}/versions?${query}`,
        schema: VersionList,
      }),
    );
    versions.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return versions;
}

async function exportVersion(
  io: Io,
  session: Session,
  folder: SafeFolder,
  out: string,
  artifactId: string,
  version: VersionSummary,
  windows: boolean,
): Promise<ExportedVersion> {
  const kinds: DownloadKind[] = version.sourceFiles > 0 ? ["published", "source"] : ["published"];
  const files: ExportedFile[] = [];
  for (const kind of kinds) {
    const download = await fetchLinks(session, artifactId, version.id, kind);
    // The same rules as `pull`, before anything is written: canonical paths, no `.git`, and no
    // two paths a case-insensitive or normalizing file system would store as one.
    checkDownloadPaths(download, messages.exportSpace.unsafePath);
    const base = exportVersionFolder(artifactId, version.number, kind).split("/");
    const jobs = download.files.map((file) => ({
      file,
      segments: [...base, ...segmentsOf(file.path, windows)],
    }));
    const links = new Map(download.files.map((file) => [file.path, file]));
    let next = 0;
    let failure: { error: unknown } | undefined;
    const worker = async () => {
      while (!failure && next < jobs.length) {
        const job = jobs[next] as (typeof jobs)[number];
        next += 1;
        try {
          await fetchToFile(
            session,
            folder,
            job.file.path,
            job.segments,
            () => links.get(job.file.path) as DownloadLink,
            async () => {
              const fresh = await fetchLinks(session, artifactId, version.id, kind, job.file.path);
              const link = fresh.files[0];
              if (link) links.set(job.file.path, link);
            },
          );
        } catch (error) {
          failure ??= { error };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, jobs.length) }, worker));
    if (failure) {
      if (skipReason(failure.error) === null) io.stderr(`${messages.exportSpace.resume(out)}\n`);
      throw failure.error;
    }
    files.push(
      ...download.files.map((file) => ({
        kind,
        path: file.path,
        size: file.size,
        sha256: file.sha256,
      })),
    );
  }
  return {
    id: version.id,
    number: version.number,
    current: version.current,
    folder: `artifacts/${artifactId}/v${version.number}`,
    files,
  };
}

/** A file's segments under its version's folder, refused when they are unsafe here. */
export function segmentsOf(path: string, windows: boolean): string[] {
  const segments = exportPathSegments(path, windows);
  if (!segments.ok) {
    throw new CliError("server_error", messages.exportSpace.unsafePath(path, segments.message));
  }
  return segments.value;
}

/**
 * A file that is already in place and verified is kept; anything else is fetched again into a
 * temporary file of its own, put in place, and read back: it counts only when the bytes at its
 * final place have the right size and SHA-256. Only the network (the request and reading its
 * body) is retried: storage links are renewed before they expire or once after storage refuses
 * one, and transient failures are retried with backoff. A disk error (`EACCES`, `ENOSPC`, a
 * failing `rename`) stops at once as `write_failed`, and a body larger than its size is cut off
 * before it can fill the disk.
 */
async function fetchToFile(
  session: Session,
  folder: SafeFolder,
  path: string,
  segments: string[],
  link: () => DownloadLink,
  renew: () => Promise<void>,
): Promise<void> {
  const expected = link();
  if (await onDisk(path, () => folder.holds(segments, expected.size, expected.sha256))) return;
  const { runtime } = session;
  let renewed = false;
  let failures = 0;
  for (;;) {
    const current = link();
    if (!renewed && Date.parse(current.expiresAt) - runtime.now() <= URL_EXPIRY_MARGIN_MS) {
      renewed = true;
      await renew();
      continue;
    }
    let status = 0;
    let response: Response | null = null;
    try {
      // Storage links carry their own signature; the API token never goes to storage.
      response = await runtime.fetch(current.url, { method: "GET", redirect: "manual" });
      status = response.status;
    } catch {
      status = 0;
    }
    if (response?.ok && response.body) {
      const fetched = await streamToDisk(path, folder, response.body, current.size);
      if (fetched === "network") {
        status = 0;
      } else {
        const placed = await onDisk(path, () => folder.place(fetched, segments));
        if (!(await onDisk(path, () => folder.holds(segments, current.size, current.sha256)))) {
          await rm(placed, { force: true });
          throw new CliError("download_failed", messages.exportSpace.mismatch(path));
        }
        return;
      }
    } else {
      await response?.body?.cancel().catch(() => undefined);
    }
    if (status === 403 && !renewed) {
      renewed = true;
      await renew();
      continue;
    }
    const transient = status === 0 || status >= 500 || status === 429;
    failures += 1;
    if (transient && failures < RETRY_ATTEMPTS) {
      await runtime.sleep(RETRY_BASE_MS * 2 ** (failures - 1));
      continue;
    }
    throw new CliError("download_failed", messages.errors.downloadFailed(path));
  }
}

/**
 * Streams a response body into a new temporary file, at most `size` bytes. Answers the temporary
 * file's path, or `network` when reading the body failed (worth retrying). A disk error throws
 * `write_failed`, and a body longer than `size` throws a mismatch: neither is retried.
 */
async function streamToDisk(
  path: string,
  folder: SafeFolder,
  body: ReadableStream<Uint8Array>,
  size: number,
): Promise<string | "network"> {
  const temporary = await onDisk(path, () => folder.temporary());
  const reader = body.getReader();
  let written = 0;
  let outcome: string | "network" = temporary.path;
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        outcome = "network";
        break;
      }
      if (chunk.done) break;
      written += chunk.value.byteLength;
      if (written > size) {
        await reader.cancel().catch(() => undefined);
        throw new CliError("download_failed", messages.exportSpace.tooLarge(path, size));
      }
      await onDisk(path, () => temporary.handle.write(chunk.value));
    }
  } catch (error) {
    await temporary.handle.close().catch(() => undefined);
    await rm(temporary.path, { force: true });
    throw error;
  }
  await onDisk(path, () => temporary.handle.close());
  if (outcome === "network") await rm(temporary.path, { force: true });
  return outcome;
}

/** Runs a disk step; a file system error becomes `write_failed` naming the file and its code. */
async function onDisk<T>(path: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new CliError("write_failed", messages.exportSpace.writeFailed(path, code));
  }
}

/**
 * One artifact's access log as JSON Lines, written to disk page by page, or why the caller may not
 * read it now.
 */
async function exportAccessLog(
  session: Session,
  folder: SafeFolder,
  artifactId: string,
): Promise<ExportedLog> {
  const file = `artifacts/${artifactId}/access-log.jsonl`;
  const temporary = await folder.temporary();
  let lines = 0;
  try {
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: String(PAGE) });
      if (cursor !== null) query.set("cursor", cursor);
      const page: AccessLogView = await withRetries(session, () =>
        callApi(session, {
          method: "GET",
          path: `/artifacts/${artifactId}/access-log?${query}`,
          schema: AccessLogView,
        }),
      );
      for (const entry of page.entries) {
        await temporary.handle.write(`${JSON.stringify(entry)}\n`);
        lines += 1;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  } catch (error) {
    await temporary.handle.close();
    await rm(temporary.path, { force: true });
    const skipped = skipReason(error);
    if (skipped) return { skipped };
    throw error;
  }
  await temporary.handle.close();
  await folder.place(temporary.path, file.split("/"));
  return { file, lines };
}

/** The space's audit log as JSON Lines, following every part, or why it is not there now. */
async function exportAudit(
  session: Session,
  folder: SafeFolder,
  workspace: string | undefined,
): Promise<ExportedLog> {
  const file = "audit.jsonl";
  const temporary = await folder.temporary();
  let lines = 0;
  try {
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ format: "jsonl" });
      if (cursor !== null) query.set("cursor", cursor);
      const path = `/audit/export${workspaceQuery(workspace, query)}`;
      // Only a resumed part is safe to repeat: the first one starts the export and records it.
      const answer: { text: string; headers: Headers } =
        cursor === null
          ? await downloadApi(session, path)
          : await withRetries(session, () => downloadApi(session, path));
      await temporary.handle.write(answer.text);
      lines += answer.text.split("\n").filter((line) => line !== "").length;
      cursor = answer.headers.get(AUDIT_EXPORT_CURSOR_HEADER);
    } while (cursor !== null);
  } catch (error) {
    await temporary.handle.close();
    await rm(temporary.path, { force: true });
    const skipped = skipReason(error);
    if (skipped) return { skipped };
    throw error;
  }
  await temporary.handle.close();
  await folder.place(temporary.path, [file]);
  return { file, lines };
}

/**
 * A read whose refusal is recorded in the records file instead of stopping the export: the
 * export's skip reasons, and `unavailable` for a feature switched off on the deployment (capacity protection never
 * refuses reads).
 */
async function recordPart<T>(read: () => Promise<T>): Promise<RecordPart<T>> {
  try {
    return await read();
  } catch (error) {
    const skipped = skipReason(error);
    if (skipped) return { skipped };
    if (error instanceof CliError && error.code === "capacity_unavailable") {
      return { skipped: "unavailable" };
    }
    throw error;
  }
}

const DASHBOARD_ONLY = async (): Promise<SkippedRecord> => ({ skipped: "dashboard_only" });

/**
 * One artifact's `records.json`, or why it is not there. `retryLater` when a part of it asked to
 * wait. A resumed export keeps a file it already wrote in this export, complete, when its bytes
 * at their place still match the journal; otherwise every part is read again (7 requests and one
 * more per history page and per extra analytics range).
 */
async function exportArtifactRecords(
  session: Session,
  folder: SafeFolder,
  artifactId: string,
  journal: RecordsJournal,
): Promise<{ file: ExportedRecordFile; retryLater: boolean }> {
  const file = `artifacts/${artifactId}/records.json`;
  const kept = journal.records[artifactId];
  if (kept && (await folder.holds(file.split("/"), kept.size, kept.sha256))) {
    return { file: { file }, retryLater: false };
  }
  const get = <T>(path: string, schema: ZodType<T>) =>
    withRetries(session, () =>
      callApi(session, { method: "GET", path: `/artifacts/${artifactId}${path}`, schema }),
    );
  let artifact: ArtifactSummary;
  try {
    artifact = await get("", ArtifactSummary);
  } catch (error) {
    const skipped = skipReason(error);
    if (!skipped) throw error;
    return { file: { skipped }, retryLater: skipped === "rate_limited" };
  }
  const records = await collectArtifactRecords(
    artifact,
    {
      access: () => recordPart(() => get("/access", AccessPolicyView)),
      shareLinks: () => recordPart(() => get("/share-links", ShareLinkList)),
      approvalReview: () => recordPart(() => get("/review/status", ApprovalReviewView)),
      stats: (range) =>
        recordPart(() =>
          get(`/stats${range ? `?${new URLSearchParams(range)}` : ""}`, ArtifactStatsView),
        ),
      comments: (version) =>
        recordPart(() =>
          get(
            `/annotations/export?${new URLSearchParams({ format: "json", version })}`,
            AnnotationExport,
          ),
        ),
      commentHistory: (cursor) =>
        recordPart(() =>
          get(
            `/annotations/history?${new URLSearchParams({ limit: String(ANNOTATION_HISTORY_PAGE.max), ...(cursor === undefined ? {} : { cursor }) })}`,
            AnnotationHistoryPage,
          ),
        ),
    },
    session.runtime.now(),
  );
  const text = `${JSON.stringify(ArtifactRecords.parse(records), null, 2)}\n`;
  await folder.writeText(file.split("/"), text);
  const retryLater = recordsRetryLater(records);
  if (retryLater) {
    delete journal.records[artifactId];
  } else {
    const size = Buffer.byteLength(text);
    const sha256 = createHash("sha256").update(text).digest("hex");
    // Counted only once read back from its place, like every other file of the export.
    if (await folder.holds(file.split("/"), size, sha256)) {
      journal.records[artifactId] = { size, sha256 };
      await folder.writeText([RECORDS_JOURNAL], `${JSON.stringify(journal)}\n`);
    }
  }
  return { file: { file }, retryLater };
}

/** The space's `space.json`: what bearer routes read, the rest marked `dashboard_only`. */
async function exportSpaceRecords(
  session: Session,
  folder: SafeFolder,
  workspace: string | undefined,
  ownerId: string,
): Promise<{ file: ExportedRecordFile; retryLater: boolean }> {
  const get = <T>(path: string, schema: ZodType<T>) =>
    withRetries(session, () => callApi(session, { method: "GET", path, schema }));
  const records = await collectSpaceRecords(
    { ownerId, slug: workspace ?? null },
    {
      workspace: () =>
        recordPart(async () => {
          const list = await get("/workspaces", WorkspaceList);
          const found = list.items.find((item) => item.slug === workspace);
          if (!found) throw new CliError("not_found", messages.exportSpace.workspaceGone);
          return found;
        }),
      members: DASHBOARD_ONLY,
      invitations: DASHBOARD_ONLY,
      groups: () =>
        recordPart(() => get(`/workspaces/${workspace ?? ""}/groups`, WorkspaceGroupList)),
      group: DASHBOARD_ONLY,
      emailDomains: DASHBOARD_ONLY,
      policies: DASHBOARD_ONLY,
      serviceTokens: DASHBOARD_ONLY,
      githubTrust: DASHBOARD_ONLY,
      sso: DASHBOARD_ONLY,
      scim: DASHBOARD_ONLY,
      branding: DASHBOARD_ONLY,
      webhooks: () => recordPart(() => get(`/webhooks${workspaceQuery(workspace)}`, WebhookList)),
      integrations: DASHBOARD_ONLY,
      auditStreams: DASHBOARD_ONLY,
    },
    session.runtime.now(),
  );
  const file = "space.json";
  await folder.writeText([file], `${JSON.stringify(SpaceRecords.parse(records), null, 2)}\n`);
  return { file: { file }, retryLater: recordsRetryLater(records) };
}
