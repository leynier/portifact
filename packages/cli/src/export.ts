// portifact export: everything a space holds, into a folder (decision 0022, second delivery).
// Every artifact and every retained version through the version download route (published files
// and, when there are any, the private sources), each artifact's access log and the space's audit
// log when the caller may read them, and `manifest.json`, written last, describing what is there.
// It only uses the routes `list`, `versions`, `pull`, `logs` and `audit export` use: the server
// never builds an archive. Each file streams to disk while it is hashed, so memory stays bounded,
// and is kept only once its size and SHA-256 match; a second run skips what is complete and
// verified and fetches the rest again, so an interrupted export resumes where it stopped.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AccessLogView,
  AccountUsageView,
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
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";
import { DOWNLOAD_CONCURRENCY, fetchLinks } from "./pull.ts";
import type { Io, Runtime } from "./runtime.ts";
import type { Session } from "./session.ts";
import { URL_EXPIRY_MARGIN_MS } from "./upload.ts";
import { chosenWorkspace, workspaceQuery } from "./workspaces.ts";

/** The file that marks a folder as an export, so a run never writes into an unrelated folder. */
export const EXPORT_MARKER = ".portifact-export";
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
}

export async function exportSpace(
  io: Io,
  runtime: Runtime,
  folder: string,
  options: ExportOptions,
): Promise<void> {
  const out = resolve(folder);
  if (out.split(sep).some(isGitSegment)) {
    throw new CliError("invalid_input", messages.errors.outInsideGit(out));
  }
  const session = await openSession(io, runtime);
  const workspace =
    options.workspace === undefined ? undefined : await chosenWorkspace(session, options.workspace);
  const space = workspace ?? "personal";
  const planned = await planExport(session, workspace);
  const versions = planned.reduce((sum, item) => sum + item.versions.length, 0);
  const bytes = planned.reduce(
    (sum, item) =>
      sum +
      item.versions.reduce((v, version) => v + version.publishedBytes + version.sourceBytes, 0),
    0,
  );
  const files = planned.reduce(
    (sum, item) =>
      sum +
      item.versions.reduce((v, version) => v + version.publishedFiles + version.sourceFiles, 0),
    0,
  );

  if (options.dryRun) {
    const grace = await graceOf(session, workspace);
    if (options.json) {
      writeJson(io, {
        dryRun: true,
        space,
        out,
        artifacts: planned.length,
        versions,
        files,
        bytes,
        grace,
      });
      return;
    }
    io.stdout(
      `${messages.exportSpace.dryRun(space, planned.length, versions, files, bytes, out)}\n`,
    );
    for (const kind of grace?.kinds ?? []) {
      io.stdout(`${messages.exportSpace.goes(kind.kind, kind.count, kind.from)}\n`);
    }
    return;
  }

  await prepareFolder(out, space);
  const windows = options.windows ?? process.platform === "win32";
  const manifest: ExportManifest = {
    format: EXPORT_MANIFEST_FORMAT,
    space,
    exportedAt: new Date(runtime.now()).toISOString(),
    artifacts: [],
    audit: { skipped: "not_found" },
    totals: { artifacts: 0, versions: 0, files: 0, bytes: 0 },
  };
  let accessLogs: "allowed" | ExportSkipReason = "allowed";
  let done = 0;
  for (const item of planned) {
    const exported: ExportedVersion[] = [];
    for (const version of item.versions) {
      exported.push(await exportVersion(io, session, out, item.artifact.id, version, windows));
      done += 1;
      io.stderr(
        `${messages.exportSpace.progress(done, versions, item.artifact.id, version.number)}\n`,
      );
    }
    let accessLog: ExportedLog;
    if (accessLogs === "allowed") {
      accessLog = await exportAccessLog(session, out, item.artifact.id);
      // A role that may not read one artifact's access log reads none of the space's.
      if ("skipped" in accessLog && accessLog.skipped !== "not_found")
        accessLogs = accessLog.skipped;
    } else {
      accessLog = { skipped: accessLogs };
    }
    manifest.artifacts.push({
      id: item.artifact.id,
      name: item.artifact.name,
      versions: exported,
      accessLog,
    });
  }
  manifest.audit = await exportAudit(session, out, workspace);
  const all = manifest.artifacts.flatMap((a) => a.versions.flatMap((v) => v.files));
  manifest.totals = {
    artifacts: manifest.artifacts.length,
    versions: manifest.artifacts.reduce((sum, a) => sum + a.versions.length, 0),
    files: all.length,
    bytes: all.reduce((sum, file) => sum + file.size, 0),
  };
  await writeAtomically(
    join(out, EXPORT_MANIFEST_FILE),
    `${JSON.stringify(ExportManifest.parse(manifest), null, 2)}\n`,
  );
  if (options.json) {
    writeJson(io, { out, ...manifest.totals, audit: manifest.audit });
    return;
  }
  io.stdout(
    `${messages.exportSpace.done(space, manifest.totals.artifacts, manifest.totals.versions, manifest.totals.files, manifest.totals.bytes, out)}\n`,
  );
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
      planned.push({ artifact, versions: await versionsOf(session, artifact.id) });
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

/** The running grace and what it lets go, for the dry run; null when the space has none. */
async function graceOf(session: Session, workspace: string | undefined) {
  const usage = await callApi(session, {
    method: "GET",
    path: `/usage${workspaceQuery(workspace)}`,
    schema: AccountUsageView,
  });
  if (!usage.plan.grace) return null;
  return callApi(session, {
    method: "GET",
    path: `/grace-forecast${workspaceQuery(workspace)}`,
    schema: GraceForecastView,
  });
}

/**
 * The folder is new, empty, or an earlier export of the same space: anything else is refused, so
 * an export never writes into an unrelated folder or mixes two spaces.
 */
async function prepareFolder(out: string, space: string): Promise<void> {
  await mkdir(out, { recursive: true });
  const entries = await readdir(out);
  const marker = join(out, EXPORT_MARKER);
  if (entries.length > 0) {
    let owner: string | null = null;
    try {
      owner = (await readText(marker)).trim();
    } catch {
      owner = null;
    }
    if (owner !== space) throw new CliError("invalid_input", messages.exportSpace.notAnExport(out));
    return;
  }
  await writeAtomically(marker, `${space}\n`);
}

async function exportVersion(
  io: Io,
  session: Session,
  out: string,
  artifactId: string,
  version: VersionSummary,
  windows: boolean,
): Promise<ExportedVersion> {
  const kinds: DownloadKind[] = version.sourceFiles > 0 ? ["published", "source"] : ["published"];
  const files: ExportedFile[] = [];
  for (const kind of kinds) {
    const download = await fetchLinks(session, artifactId, version.id, kind);
    const root = join(out, ...exportVersionFolder(artifactId, version.number, kind).split("/"));
    const links = new Map(download.files.map((file) => [file.path, file]));
    const jobs = download.files.map((file) => ({
      file,
      target: targetFor(root, file.path, windows),
    }));
    let next = 0;
    let failure: { error: unknown } | undefined;
    const worker = async () => {
      while (!failure && next < jobs.length) {
        const job = jobs[next] as (typeof jobs)[number];
        next += 1;
        try {
          await fetchToFile(
            session,
            job.file.path,
            job.target,
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
      io.stderr(`${messages.exportSpace.resume(out)}\n`);
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

/** Where a file goes, refused when it would leave its version's folder or is unsafe here. */
export function targetFor(root: string, path: string, windows: boolean): string {
  const segments = exportPathSegments(path, windows);
  if (!segments.ok) {
    throw new CliError("server_error", messages.errors.unsafePath(path, segments.message));
  }
  const target = join(root, ...segments.value);
  const inside = relative(root, target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new CliError("server_error", messages.errors.unsafePath(path, "outside the folder"));
  }
  return target;
}

/**
 * A file that is already complete and verified is kept; anything else is fetched again into a
 * `.part` file, hashed while it streams, and renamed into place only once its size and SHA-256
 * match. Storage links are renewed before they expire or once after storage refuses one, and
 * transient failures are retried with backoff.
 */
async function fetchToFile(
  session: Session,
  path: string,
  target: string,
  link: () => DownloadLink,
  renew: () => Promise<void>,
): Promise<void> {
  const expected = link();
  if (await matches(target, expected.size, expected.sha256)) return;
  await mkdir(dirname(target), { recursive: true });
  const part = `${target}.part`;
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
        const { size, sha256 } = await streamTo(response.body, part);
        if (size !== current.size || sha256 !== current.sha256) {
          await rm(part, { force: true });
          throw new CliError("download_failed", messages.errors.downloadMismatch(path));
        }
        await rename(part, target);
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

/** Writes a stream to `file` chunk by chunk, hashing it, and answers its size and SHA-256. */
async function streamTo(body: ReadableStream<Uint8Array>, file: string) {
  const handle = await open(file, "w");
  const hash = createHash("sha256");
  let size = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      size += value.byteLength;
      await handle.write(value);
    }
  } finally {
    await handle.close();
  }
  return { size, sha256: hash.digest("hex") };
}

/** Whether `file` exists with exactly this size and SHA-256 (read as a stream). */
async function matches(file: string, size: number, sha256: string): Promise<boolean> {
  try {
    if ((await stat(file)).size !== size) return false;
  } catch {
    return false;
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex") === sha256;
}

/** One artifact's access log as JSON Lines, every page, or why the caller may not read it. */
async function exportAccessLog(
  session: Session,
  out: string,
  artifactId: string,
): Promise<ExportedLog> {
  const file = `artifacts/${artifactId}/access-log.jsonl`;
  const lines: string[] = [];
  let cursor: string | null = null;
  try {
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
      for (const entry of page.entries) lines.push(JSON.stringify(entry));
      cursor = page.nextCursor;
    } while (cursor !== null);
  } catch (error) {
    const skipped = skipReason(error);
    if (skipped) return { skipped };
    throw error;
  }
  await mkdir(join(out, "artifacts", artifactId), { recursive: true });
  await writeAtomically(join(out, ...file.split("/")), lines.map((line) => `${line}\n`).join(""));
  return { file, lines: lines.length };
}

/** The space's audit log as JSON Lines, following every part, or why it is not there. */
async function exportAudit(
  session: Session,
  out: string,
  workspace: string | undefined,
): Promise<ExportedLog> {
  const file = "audit.jsonl";
  const part = join(out, `${file}.part`);
  const handle = await open(part, "w");
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
      await handle.write(answer.text);
      lines += answer.text.split("\n").filter((line) => line !== "").length;
      cursor = answer.headers.get(AUDIT_EXPORT_CURSOR_HEADER);
    } while (cursor !== null);
  } catch (error) {
    await handle.close();
    await rm(part, { force: true });
    const skipped = skipReason(error);
    if (skipped) return { skipped };
    throw error;
  }
  await handle.close();
  await rename(part, join(out, file));
  return { file, lines };
}

/** Refusals that mean "not yours to export" rather than a failure. */
function skipReason(error: unknown): ExportSkipReason | null {
  if (!(error instanceof CliError)) return null;
  if (error.code === "forbidden" || error.code === "plan_required" || error.code === "not_found") {
    return error.code;
  }
  return null;
}

async function writeAtomically(file: string, text: string): Promise<void> {
  const part = `${file}.part`;
  const handle = await open(part, "w");
  try {
    await handle.write(text);
  } finally {
    await handle.close();
  }
  await rename(part, file);
}

async function readText(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
