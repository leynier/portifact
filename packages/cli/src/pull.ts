// portifact pull: download a version's published files, its private sources or both into a new
// folder (plan section 6). The server answers with short-lived links; each file is fetched
// without the API token, checked against its size and SHA-256 and written only inside the new
// folder: `published/` and `source/` under it. Paths are checked before anything is written, and
// a path with a `.git` segment is refused, so a pull can never install Git hooks or configuration.
import { createHash } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CURRENT_VERSION,
  type DownloadKind,
  type DownloadLink,
  VersionDownload,
} from "@portifact/contracts";
import { isGitSegment, validateManifestPaths } from "@portifact/domain";
import { callApi, RETRY_ATTEMPTS, withRetries } from "./api.ts";
import { parseArtifactId } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";
import type { Session } from "./session.ts";
import { URL_EXPIRY_MARGIN_MS } from "./upload.ts";
import { parseVersionId } from "./versions.ts";

/** Downloads in flight at once. */
export const DOWNLOAD_CONCURRENCY = 4;
const RETRY_BASE_MS = 1_000;

export interface PullOptions extends OutputOptions {
  out: string;
  version?: string | undefined;
  published: boolean;
  source: boolean;
}

interface Job {
  kind: DownloadKind;
  path: string;
  target: string;
}

export async function pull(io: Io, runtime: Runtime, id: string, options: PullOptions) {
  const artifactId = parseArtifactId(id);
  const versionRef =
    options.version === undefined ? CURRENT_VERSION : parseVersionId(options.version);
  const kinds: DownloadKind[] = [];
  if (options.published || !options.source) kinds.push("published");
  if (options.source) kinds.push("source");
  const out = resolve(options.out);
  if (out.split(sep).some(isGitSegment)) {
    throw new CliError("invalid_input", messages.errors.outInsideGit(out));
  }
  if (await exists(out)) throw new CliError("invalid_input", messages.errors.outExists(out));

  const session = await openSession(io, runtime);
  // Every kind comes from the same version, even if a new one is published meanwhile.
  const first = await fetchLinks(session, artifactId, versionRef, kinds[0] as DownloadKind);
  const downloads = [first];
  for (const kind of kinds.slice(1)) {
    downloads.push(await fetchLinks(session, artifactId, first.versionId, kind));
  }
  const jobs = downloads.flatMap((download) => plan(out, download));

  await mkdir(dirname(out), { recursive: true });
  try {
    await mkdir(out);
  } catch {
    throw new CliError("invalid_input", messages.errors.outExists(out));
  }
  try {
    await downloadAll(io, session, artifactId, downloads, jobs);
  } catch (error) {
    // The folder is new and only this command wrote to it, so nothing else is lost.
    await rm(out, { recursive: true, force: true });
    io.stderr(`${messages.errors.pullCleanedUp(out)}\n`);
    throw error;
  }

  const files = downloads.flatMap((download) =>
    download.files.map((file) => ({
      kind: download.kind,
      path: file.path,
      size: file.size,
      sha256: file.sha256,
    })),
  );
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (options.json) {
    writeJson(io, {
      artifactId,
      versionId: first.versionId,
      versionNumber: first.versionNumber,
      out,
      files,
      totalBytes,
    });
    return;
  }
  io.stdout(`${messages.pulled(files.length, totalBytes, first.versionNumber, artifactId, out)}\n`);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export function fetchLinks(
  session: Session,
  artifactId: string,
  versionRef: string,
  kind: DownloadKind,
  path?: string,
): Promise<VersionDownload> {
  const query = new URLSearchParams({ kind });
  if (path !== undefined) query.set("path", path);
  return withRetries(session, () =>
    callApi(session, {
      method: "GET",
      path: `/artifacts/${artifactId}/versions/${encodeURIComponent(versionRef)}/download?${query}`,
      schema: VersionDownload,
    }),
  );
}

/**
 * Where each file goes, checked before anything is written. The server validates manifests, but
 * the CLI does not trust it with the local disk: every path must already be canonical, unique
 * regardless of case, free of `.git` segments and inside the folder of its kind.
 */
function plan(out: string, download: VersionDownload): Job[] {
  checkDownloadPaths(download);
  const root = join(out, download.kind);
  return download.files.map((file) => {
    const target = join(root, ...file.path.split("/"));
    const inside = relative(root, target);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
      throw new CliError(
        "server_error",
        messages.errors.unsafePath(file.path, "outside the folder"),
      );
    }
    return { kind: download.kind, path: file.path, target };
  });
}

/**
 * Refuses a download whose paths are not already canonical, unique regardless of case and free of
 * `.git` segments, with the same rules the server applies to manifests.
 */
export function checkDownloadPaths(download: VersionDownload): void {
  const paths = download.files.map((file) => file.path);
  const checked = validateManifestPaths(paths);
  if (!checked.ok) {
    const path = paths.find((p) => checked.message.startsWith(`${p}:`)) ?? "";
    throw new CliError("server_error", messages.errors.unsafePath(path, checked.message));
  }
  download.files.forEach((file, index) => {
    if (checked.value[index] !== file.path) {
      throw new CliError("server_error", messages.errors.unsafePath(file.path, "not canonical"));
    }
  });
}

async function downloadAll(
  io: Io,
  session: Session,
  artifactId: string,
  downloads: VersionDownload[],
  jobs: Job[],
): Promise<void> {
  const links = new Map<string, DownloadLink>();
  const key = (kind: DownloadKind, path: string) => `${kind}\u0000${path}`;
  for (const download of downloads) {
    for (const file of download.files) links.set(key(download.kind, file.path), file);
  }
  const versionId = (downloads[0] as VersionDownload).versionId;
  const renew = async (job: Job) => {
    const fresh = await fetchLinks(session, artifactId, versionId, job.kind, job.path);
    const link = fresh.files[0];
    if (link) links.set(key(job.kind, job.path), link);
  };

  let next = 0;
  let done = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < jobs.length) {
      const job = jobs[next] as Job;
      next += 1;
      try {
        await downloadOne(
          session,
          job,
          () => links.get(key(job.kind, job.path)) as DownloadLink,
          renew,
        );
        done += 1;
        io.stderr(`${messages.downloaded(done, jobs.length)}\n`);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, jobs.length) }, worker));
  if (failure) throw failure.error;
}

async function downloadOne(
  session: Session,
  job: Job,
  link: () => DownloadLink,
  renew: (job: Job) => Promise<void>,
): Promise<void> {
  const bytes = await downloadVerified(session, job.path, link, () => renew(job));
  await mkdir(dirname(job.target), { recursive: true });
  // `wx` never replaces or follows anything already at the target.
  await writeFile(job.target, bytes, { flag: "wx" });
}

/**
 * Fetches the bytes behind a short-lived storage link and checks them against its size and
 * SHA-256. `renew` replaces the link `link()` returns: once before it expires, or once after
 * storage refuses it as expired. Transient failures are retried with backoff.
 */
export async function downloadVerified(
  session: Session,
  path: string,
  link: () => DownloadLink,
  renew: () => Promise<void>,
): Promise<Buffer> {
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
    let bytes: Buffer | undefined;
    let status = 0;
    try {
      // Storage links carry their own signature; the API token never goes to storage.
      const response = await runtime.fetch(current.url, { method: "GET", redirect: "manual" });
      status = response.status;
      if (response.ok) bytes = Buffer.from(await response.arrayBuffer());
      else await response.body?.cancel();
    } catch {
      status = 0;
    }
    if (bytes) {
      if (bytes.length !== current.size || sha256Of(bytes) !== current.sha256) {
        throw new CliError("download_failed", messages.errors.downloadMismatch(path));
      }
      return bytes;
    }
    // Storage answers 403 to an expired signature: get a fresh link once and try again.
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

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
