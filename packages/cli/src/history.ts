// portifact pull --source --git: the private sources of every retained version as a local Git
// repository, one commit and tag per version from the oldest to the newest (plan section 6,
// "Historial como repo git"). It only composes the version list and the source downloads of the
// API. Every path is checked with the manifest rules before anything is written, so nothing lands
// inside `.git`. Each blob is downloaded once by SHA-256 and checked, then stored with git
// plumbing (hash-object, update-index on a separate index file, commit-tree and one update-ref
// transaction), which runs no hooks and no filters. The work tree is updated by `read-tree -u -m`,
// which refuses to overwrite local changes or to write through a symbolic link.
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { DownloadLink, VersionDownload, VersionSummary } from "@portifact/contracts";
import { isGitSegment } from "@portifact/domain";
import { parseArtifactId } from "./artifacts.ts";
import { type OutputOptions, openSession, signedInPrincipal, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import type { Git, GitCallOptions } from "./git.ts";
import { messages } from "./messages.ts";
import {
  checkDownloadPaths,
  DOWNLOAD_CONCURRENCY,
  downloadVerified,
  exists,
  fetchLinks,
} from "./pull.ts";
import type { Io, Runtime } from "./runtime.ts";
import type { Session } from "./session.ts";
import { listAllVersions } from "./versions.ts";

export const HISTORY_BRANCH = "main";
const BRANCH_REF = `refs/heads/${HISTORY_BRANCH}`;
/** Repository setting that records which artifact a history belongs to. */
export const ARTIFACT_KEY = "portifact.artifact";
export const VERSION_TRAILER = "Portifact-Version";
export const SOURCE_COMMIT_TRAILER = "Source-Commit";

export interface HistoryOptions extends OutputOptions {
  out: string;
  source: boolean;
  published: boolean;
  version?: string | undefined;
}

/** Whether a version's commit carries its sources, or is empty and says why. */
type SourcesState = "attached" | "none" | "purged";

interface PendingVersion {
  summary: VersionSummary;
  sources: SourcesState;
  download?: VersionDownload | undefined;
}

interface Previous {
  head: string;
  tree: string;
  version: number;
}

interface Committed {
  version: PendingVersion;
  commit: string;
}

export async function pullHistory(
  io: Io,
  runtime: Runtime,
  id: string,
  options: HistoryOptions,
): Promise<void> {
  if (!options.source) throw new CliError("invalid_input", messages.errors.gitNeedsSource);
  if (options.published) throw new CliError("invalid_input", messages.errors.gitWithPublished);
  if (options.version !== undefined) {
    throw new CliError("invalid_input", messages.errors.gitWithVersion);
  }
  const artifactId = parseArtifactId(id);
  const out = resolve(options.out);
  if (out.split(sep).some(isGitSegment)) {
    throw new CliError("invalid_input", messages.errors.outInsideGit(out));
  }
  const git = runtime.git;
  await requireGit(git);
  const previous = (await exists(out)) ? await openHistory(git, out, artifactId) : undefined;

  const session = await openSession(io, runtime);
  const all = (await listAllVersions(session, artifactId)).sort((a, b) => a.number - b.number);
  const newest = all.at(-1)?.number ?? 0;
  if (previous && newest < previous.version) {
    throw new CliError(
      "invalid_input",
      messages.errors.historyDiverged(
        out,
        `it has version ${previous.version}, newer than ${artifactId}`,
      ),
    );
  }
  const pending = all.filter((version) => version.number > (previous?.version ?? 0));
  if (pending.length === 0) {
    report(io, options, artifactId, out, previous, []);
    return;
  }
  if (previous) await refuseExistingTags(git, out, pending);
  // Only the owner reads versions and only the owner publishes, so the publisher is this account.
  const author = authorName((await signedInPrincipal(session)).userId);

  // Every manifest is read and checked before anything is written.
  const versions: PendingVersion[] = [];
  for (const summary of pending) versions.push(await sourcesOf(session, artifactId, summary));

  let created = false;
  if (!previous) {
    await mkdir(dirname(out), { recursive: true });
    try {
      await mkdir(out);
    } catch {
      throw new CliError("invalid_input", messages.errors.outExists(out));
    }
    created = true;
  }
  let committed: Committed[];
  try {
    if (created) await initHistory(git, out, artifactId);
    const emptyTree = await objectId(git, ["hash-object", "-w", "-t", "tree", "--stdin"], out, {
      input: Buffer.alloc(0),
    });
    const blobs = await storeBlobs(io, session, git, out, artifactId, versions);
    const base = previous ?? { head: undefined, tree: emptyTree };
    committed = await commitVersions(git, out, versions, blobs, base, author);
    await publishCommits(git, out, previous?.head ?? emptyTree, previous?.head, committed);
  } catch (error) {
    // The folder is new and only this command wrote to it, so nothing else is lost.
    if (created) {
      await rm(out, { recursive: true, force: true });
      io.stderr(`${messages.errors.pullCleanedUp(out)}\n`);
    }
    throw error;
  }
  report(io, options, artifactId, out, previous, committed);
}

function report(
  io: Io,
  options: OutputOptions,
  artifactId: string,
  out: string,
  previous: Previous | undefined,
  committed: Committed[],
): void {
  const head = committed.at(-1)?.commit ?? previous?.head ?? null;
  if (options.json) {
    writeJson(io, {
      artifactId,
      out,
      branch: HISTORY_BRANCH,
      head,
      versions: committed.map(({ version, commit }) => ({
        number: version.summary.number,
        versionId: version.summary.id,
        commit,
        tag: `v${version.summary.number}`,
        sources: version.sources,
        sourceCommit: version.summary.sourceOrigin?.commit ?? null,
        files: version.download?.files.length ?? 0,
      })),
    });
    return;
  }
  const first = committed[0];
  const last = committed.at(-1);
  if (!first || !last) {
    io.stdout(
      `${previous ? messages.historyUpToDate(out, previous.version, artifactId) : messages.historyNothing(artifactId)}\n`,
    );
    return;
  }
  const lines = [
    messages.historyAdded(
      committed.length,
      first.version.summary.number,
      last.version.summary.number,
      artifactId,
      out,
    ),
  ];
  for (const reason of ["none", "purged"] as const) {
    const numbers = committed
      .filter(({ version }) => version.sources === reason)
      .map(({ version }) => version.summary.number);
    if (numbers.length > 0) lines.push(messages.historyEmptyCommits(numbers, reason));
  }
  io.stdout(`${lines.join("\n")}\n`);
}

async function requireGit(git: Git): Promise<void> {
  let code: number;
  try {
    code = (await git(["--version"], tmpdir())).code;
  } catch {
    code = -1;
  }
  if (code !== 0) throw new CliError("git_failed", messages.errors.gitMissing);
}

/**
 * The state of a history an earlier pull made: a repository at `out` (not a link, not a linked
 * work tree) marked with this artifact, on its branch, whose last commit and tag were made by
 * Portifact, and without uncommitted changes. Anything else is refused before any download.
 */
async function openHistory(git: Git, out: string, artifactId: string): Promise<Previous> {
  const notOurs = () => new CliError("invalid_input", messages.errors.historyNotOurs(out));
  const diverged = (reason: string) =>
    new CliError("invalid_input", messages.errors.historyDiverged(out, reason));
  const folder = await lstat(out);
  const dotGit = await lstat(join(out, ".git")).catch(() => undefined);
  if (!folder.isDirectory() || !dotGit?.isDirectory()) throw notOurs();
  const top = await text(git, ["rev-parse", "--show-toplevel"], out);
  if (top === undefined || resolve(top) !== (await realpath(out))) throw notOurs();
  const marker = await text(git, ["config", "--local", "--get", ARTIFACT_KEY], out);
  if (marker === undefined) throw notOurs();
  if (marker !== artifactId) {
    throw new CliError("invalid_input", messages.errors.historyOtherArtifact(out, marker));
  }
  if ((await text(git, ["symbolic-ref", "--quiet", "HEAD"], out)) !== BRANCH_REF) {
    throw diverged(`${HISTORY_BRANCH} is not the checked-out branch`);
  }
  const head = await text(git, ["rev-parse", "--verify", "--quiet", `${BRANCH_REF}^{commit}`], out);
  if (head === undefined) throw diverged(`${HISTORY_BRANCH} has no commits`);
  const body = await git(["cat-file", "commit", head], out);
  const version = body.code === 0 ? trailerVersion(body.stdout.toString("utf8")) : undefined;
  if (version === undefined) throw diverged("its last commit was not made by Portifact");
  const tagged = await text(
    git,
    ["rev-parse", "--verify", "--quiet", `refs/tags/v${version}^{commit}`],
    out,
  );
  if (tagged !== head) throw diverged(`tag v${version} does not point to its last commit`);
  const status = await git(["status", "--porcelain", "-z", "--untracked-files=no"], out);
  if (status.code !== 0) throw gitFailed("status", out);
  if (status.stdout.length > 0)
    throw new CliError("invalid_input", messages.errors.historyDirty(out));
  const tree = await text(git, ["rev-parse", "--verify", "--quiet", `${head}^{tree}`], out);
  if (tree === undefined) throw gitFailed("rev-parse", out);
  return { head, tree, version };
}

/** The `Portifact-Version` trailer of a raw commit object, from its last paragraph. */
export function trailerVersion(commit: string): number | undefined {
  const blank = commit.indexOf("\n\n");
  if (blank === -1) return undefined;
  const paragraphs = commit
    .slice(blank + 2)
    .trimEnd()
    .split(/\n\s*\n/);
  const trailers = paragraphs.at(-1) ?? "";
  const pattern = new RegExp(`^${VERSION_TRAILER}: ([1-9]\\d{0,8})$`, "gm");
  const values = [...trailers.matchAll(pattern)].map((match) => Number(match[1]));
  return values.length === 1 ? values[0] : undefined;
}

async function refuseExistingTags(git: Git, out: string, pending: VersionSummary[]) {
  for (const { number } of pending) {
    if (await text(git, ["rev-parse", "--verify", "--quiet", `refs/tags/v${number}`], out)) {
      throw new CliError(
        "invalid_input",
        messages.errors.historyDiverged(out, `tag v${number} already exists`),
      );
    }
  }
}

async function sourcesOf(
  session: Session,
  artifactId: string,
  summary: VersionSummary,
): Promise<PendingVersion> {
  if (summary.sourceFiles === 0) return { summary, sources: "none" };
  let download: VersionDownload;
  try {
    download = await fetchLinks(session, artifactId, summary.id, "source");
  } catch (error) {
    // Listed a moment ago and gone now: the version left its retention, sources and all.
    if (error instanceof CliError && error.code === "not_found") {
      return { summary, sources: "purged" };
    }
    throw error;
  }
  checkDownloadPaths(download);
  return { summary, download, sources: download.files.length > 0 ? "attached" : "none" };
}

async function initHistory(git: Git, out: string, artifactId: string): Promise<void> {
  await must(git, ["init", "--quiet"], out);
  await must(git, ["symbolic-ref", "HEAD", BRANCH_REF], out);
  await must(git, ["config", "--local", ARTIFACT_KEY, artifactId], out);
}

/** Downloads every distinct blob once, checks it and stores it; resolves SHA-256 to Git IDs. */
async function storeBlobs(
  io: Io,
  session: Session,
  git: Git,
  out: string,
  artifactId: string,
  versions: PendingVersion[],
): Promise<Map<string, string>> {
  const jobs = new Map<string, { versionId: string; link: DownloadLink }>();
  for (const { download } of versions) {
    if (!download) continue;
    for (const link of download.files) {
      if (!jobs.has(link.sha256)) jobs.set(link.sha256, { versionId: download.versionId, link });
    }
  }
  const queue = [...jobs.values()];
  const blobs = new Map<string, string>();
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < queue.length) {
      const job = queue[next] as { versionId: string; link: DownloadLink };
      next += 1;
      try {
        const bytes = await downloadVerified(
          session,
          job.link.path,
          () => job.link,
          async () => {
            const fresh = await fetchLinks(
              session,
              artifactId,
              job.versionId,
              "source",
              job.link.path,
            );
            const link = fresh.files[0];
            if (link && link.sha256 === job.link.sha256) job.link = link;
          },
        );
        const blob = await objectId(git, ["hash-object", "-w", "--no-filters", "--stdin"], out, {
          input: bytes,
        });
        blobs.set(job.link.sha256, blob);
        io.stderr(`${messages.downloaded(blobs.size, queue.length)}\n`);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) }, worker));
  if (failure) throw failure.error;
  return blobs;
}

async function commitVersions(
  git: Git,
  out: string,
  versions: PendingVersion[],
  blobs: Map<string, string>,
  base: { head: string | undefined; tree: string },
  author: string,
): Promise<Committed[]> {
  let tree = base.tree;
  let parent = base.head;
  const committed: Committed[] = [];
  const scratch = await mkdtemp(join(tmpdir(), "portifact-history-"));
  try {
    for (const version of versions) {
      if (version.download && version.sources === "attached") {
        tree = await writeTree(
          git,
          out,
          join(scratch, `index-${version.summary.number}`),
          version.download,
          blobs,
        );
      }
      const date = `@${Math.floor(Date.parse(version.summary.committedAt) / 1000)} +0000`;
      const env = {
        GIT_AUTHOR_NAME: author,
        GIT_AUTHOR_EMAIL: "",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: author,
        GIT_COMMITTER_EMAIL: "",
        GIT_COMMITTER_DATE: date,
      };
      const args = ["commit-tree", "--no-gpg-sign", tree];
      if (parent) args.push("-p", parent);
      args.push("-F", "-");
      const commit = await objectId(git, args, out, {
        input: Buffer.from(commitMessage(version), "utf8"),
        env,
      });
      committed.push({ version, commit });
      parent = commit;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return committed;
}

/** The tree of one version's sources, built in a separate index so the repository's is untouched. */
async function writeTree(
  git: Git,
  out: string,
  index: string,
  download: VersionDownload,
  blobs: Map<string, string>,
): Promise<string> {
  const env = { GIT_INDEX_FILE: index };
  const entries = download.files
    .map((file) => `100644 ${blobs.get(file.sha256)}\t${file.path}\0`)
    .join("");
  await must(git, ["update-index", "--add", "-z", "--index-info"], out, {
    input: Buffer.from(entries, "utf8"),
    env,
  });
  // git skips paths it considers unsafe instead of failing; every file must be in the tree.
  const listed = await git(["ls-files", "-z"], out, { env });
  const count = listed.stdout.toString("utf8").split("\0").filter(Boolean).length;
  if (listed.code !== 0 || count !== download.files.length) {
    throw new CliError(
      "server_error",
      messages.errors.unsafePath(download.files[0]?.path ?? "", "refused by git"),
    );
  }
  return objectId(git, ["write-tree"], out, { env });
}

export function commitMessage(version: PendingVersion): string {
  const { number, sourceOrigin } = version.summary;
  const lines = [`Version ${number}`, ""];
  if (version.sources === "attached") {
    lines.push(`The private sources of version ${number}.`);
    if (sourceOrigin?.dirty) {
      lines.push("They included changes that were not committed when they were published.");
    }
  } else if (version.sources === "none") {
    lines.push(`Version ${number} has no private sources, so this commit is empty.`);
  } else {
    lines.push(
      `The private sources of version ${number} are no longer retained, so this commit is empty.`,
    );
  }
  lines.push("", `${VERSION_TRAILER}: ${number}`);
  if (sourceOrigin?.commit) lines.push(`${SOURCE_COMMIT_TRAILER}: ${sourceOrigin.commit}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Updates the work tree and the index from the last commit to the new one, then moves the branch
 * and creates the tags in one transaction. read-tree refuses before writing anything when a file
 * or link is in the way; if the transaction fails, the work tree goes back.
 */
async function publishCommits(
  git: Git,
  out: string,
  from: string,
  previousHead: string | undefined,
  committed: Committed[],
): Promise<void> {
  const head = (committed.at(-1) as Committed).commit;
  const checkout = await git(["read-tree", "-u", "-m", from, head], out);
  if (checkout.code !== 0) throw new CliError("git_failed", messages.errors.historyBlocked(out));
  const lines = [
    previousHead ? `update ${BRANCH_REF} ${head} ${previousHead}` : `create ${BRANCH_REF} ${head}`,
    ...committed.map(
      ({ version, commit }) => `create refs/tags/v${version.summary.number} ${commit}`,
    ),
  ];
  const refs = await git(["update-ref", "--stdin"], out, {
    input: Buffer.from(`${lines.join("\n")}\n`, "utf8"),
  });
  if (refs.code !== 0) {
    await git(["read-tree", "-u", "-m", head, from], out);
    throw gitFailed("update-ref", out);
  }
}

/** A Git author name from the account ID; git drops `<`, `>` and line breaks from names. */
function authorName(userId: string): string {
  const name = userId.replace(/[\p{Cc}<>]/gu, "").trim();
  return name.length > 0 ? name : "Portifact";
}

function gitFailed(step: string, out: string): CliError {
  return new CliError("git_failed", messages.errors.gitFailed(step, out));
}

/** Trimmed output of a git command that must succeed. */
async function must(
  git: Git,
  args: string[],
  out: string,
  options?: GitCallOptions,
): Promise<string> {
  const result = await git(args, out, options);
  if (result.code !== 0) throw gitFailed(args[0] ?? "", out);
  return result.stdout.toString("utf8").trim();
}

/** The object ID a git command that must succeed prints. */
async function objectId(
  git: Git,
  args: string[],
  out: string,
  options?: GitCallOptions,
): Promise<string> {
  const value = await must(git, args, out, options);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw gitFailed(args[0] ?? "", out);
  return value;
}

/** Trimmed output of a git command that may fail; undefined when it fails or prints nothing. */
async function text(git: Git, args: string[], out: string): Promise<string | undefined> {
  const result = await git(args, out);
  const value = result.stdout.toString("utf8").trim();
  return result.code === 0 && value.length > 0 ? value : undefined;
}
