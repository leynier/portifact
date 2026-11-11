// portifact export: everything a space holds, into a folder (decision 0022, second delivery).
// Every artifact and every retained version through the version download route (published files
// and, when there are any, the private sources), each artifact's access log and the space's audit
// log when the caller may read them, and `manifest.json`, written last, describing what is there.
// It only uses the routes `list`, `versions`, `pull`, `logs` and `audit export` use: the server
// never builds an archive.
//
// The folder is handled by `SafeFolder`: nothing is written through a link, every file goes
// through a temporary file of its own and counts only once read back from its place with the
// right size and SHA-256. A lock file keeps two exports out of one folder, and the folder's marker
// names the owner, so another space's export is never mixed in. A second run keeps what is
// complete and verified and fetches the rest. Something the caller may not read, or that went
// away while the export ran, is recorded as skipped; something the server asked to retry later
// (a rate limit) makes the export exit 1 with everything else written, so running it again
// completes it.
import { constants } from "node:fs";
import { open, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  AccessLogView,
  ArtifactList,
  type ArtifactListItem,
  AUDIT_EXPORT_CURSOR_HEADER,
  type DownloadKind,
  type DownloadLink,
  EXPORT_MANIFEST_FILE,
  EXPORT_MANIFEST_FORMAT,
  type ExportedFile,
  type ExportedLog,
  type ExportedVersion,
  ExportManifest,
  type ExportSkipReason,
  GraceForecastView,
  VersionList,
  type VersionSummary,
} from "@portifact/contracts";
import { exportPathSegments, exportVersionFolder, isGitSegment } from "@portifact/domain";
import { callApi, downloadApi, RETRY_ATTEMPTS, withRetries } from "./api.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError, EXIT } from "./errors.ts";
import { messages } from "./messages.ts";
import { checkDownloadPaths, DOWNLOAD_CONCURRENCY, fetchLinks } from "./pull.ts";
import type { Io, Runtime } from "./runtime.ts";
import { SafeFolder, TEMP_FOLDER } from "./safe-folder.ts";
import type { Session } from "./session.ts";
import { URL_EXPIRY_MARGIN_MS } from "./upload.ts";
import { chosenWorkspace, workspaceQuery } from "./workspaces.ts";

/** The file that marks a folder as an export of one owner. */
export const EXPORT_MARKER = ".portifact-export";
/** The file that keeps a second export out of a folder while one runs. */
export const EXPORT_LOCK = ".portifact-export.lock";
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
  await claimFolder(target, forecast.ownerId, out);
  try {
    return await writeExport(io, session, target, out, planned, {
      workspace,
      space,
      ownerId: forecast.ownerId,
      windows: options.windows ?? process.platform === "win32",
      json: options.json === true,
    });
  } finally {
    await rm(join(target.root, EXPORT_LOCK), { force: true });
  }
}

/**
 * Takes the folder for this run: refused when another export holds its lock, or when it holds
 * anything but an earlier export of this same owner (its marker names the owner's ID). The lock is
 * created exclusively, so two runs that start together never both get it.
 */
async function claimFolder(folder: SafeFolder, ownerId: string, out: string): Promise<void> {
  const marker = await folder.readText([EXPORT_MARKER]);
  const entries = (await readdir(folder.root)).filter((name) => name !== TEMP_FOLDER);
  if (marker === null ? entries.length > 0 : markerOwner(marker) !== ownerId) {
    throw new CliError("invalid_input", messages.exportSpace.notAnExport(out));
  }
  try {
    const lock = await open(
      join(folder.root, EXPORT_LOCK),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o644,
    );
    await lock.write(`${process.pid}\n`);
    await lock.close();
  } catch {
    throw new CliError("folder_in_use", messages.exportSpace.locked(out, EXPORT_LOCK));
  }
  try {
    await folder.clearTemporary();
    if (marker === null) {
      await folder.writeText([EXPORT_MARKER], `${JSON.stringify({ ownerId })}\n`);
    }
  } catch (error) {
    await rm(join(folder.root, EXPORT_LOCK), { force: true });
    throw error;
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
    totals: { artifacts: 0, versions: 0, files: 0, bytes: 0 },
  };
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
    manifest.artifacts.push({
      id: item.artifact.id,
      name: item.artifact.name,
      versions: exported,
      accessLog,
      ...(skipped ? { skipped } : {}),
    });
  }
  manifest.audit = await exportAudit(session, folder, context.workspace);
  const all = manifest.artifacts.flatMap((a) => a.versions.flatMap((v) => v.files));
  manifest.totals = {
    artifacts: manifest.artifacts.length,
    versions: manifest.artifacts.reduce((sum, a) => sum + a.versions.length, 0),
    files: all.length,
    bytes: all.reduce((sum, file) => sum + file.size, 0),
  };
  await folder.writeText(
    [EXPORT_MANIFEST_FILE],
    `${JSON.stringify(ExportManifest.parse(manifest), null, 2)}\n`,
  );

  const skippedArtifacts = manifest.artifacts.filter((a) => a.skipped !== undefined);
  const logs = [...manifest.artifacts.map((a) => a.accessLog), manifest.audit];
  const retryLater =
    skippedArtifacts.some((a) => a.skipped === "rate_limited") ||
    logs.some((log) => "skipped" in log && log.skipped === "rate_limited");
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
    if (retryLater) io.stdout(`${messages.exportSpace.incomplete}\n`);
  }
  return retryLater ? EXIT.failure : EXIT.ok;
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
 * final place have the right size and SHA-256. Storage links are renewed before they expire or
 * once after storage refuses one, and transient failures are retried with backoff.
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
  if (await folder.holds(segments, expected.size, expected.sha256)) return;
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
    try {
      // Storage links carry their own signature; the API token never goes to storage.
      const response = await runtime.fetch(current.url, { method: "GET", redirect: "manual" });
      status = response.status;
      if (response.ok && response.body) {
        const temporary = await folder.temporary();
        try {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await temporary.handle.write(value);
          }
        } finally {
          await temporary.handle.close();
        }
        const placed = await folder.place(temporary.path, segments);
        if (!(await folder.holds(segments, current.size, current.sha256))) {
          await rm(placed, { force: true });
          throw new CliError("download_failed", messages.exportSpace.mismatch(path));
        }
        return;
      }
      await response.body?.cancel();
    } catch (error) {
      if (error instanceof CliError) throw error;
      status = 0;
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
