// Builds the private sources of `publish --source` (plan section 6, "Fuentes desde git"). In a git
// repository, git chooses the files: without `--ref`, the versioned files and the new ones it does
// not ignore; with `--ref`, exactly the tree of that commit. Otherwise the folder is walked with
// the default exclusions, and a ZIP file is expanded with them. The secret filter always applies.
import { mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { LIMITS, PLANS, type SourceOrigin } from "@portifact/contracts";
import { CliError } from "./errors.ts";
import {
  archiveTree,
  type Git,
  gitRunner,
  originOf,
  repositoryOf,
  resolveCommit,
  trackedFiles,
} from "./git.ts";
import {
  type Candidate,
  contentTypeOf,
  type Excluded,
  excludedPrefix,
  exclusionOf,
  hashCandidates,
  type LocalFile,
  lstatOrFail,
  stripSharedFolder,
  walk,
} from "./manifest.ts";
import { messages } from "./messages.ts";
import { extractZip, isZipPath, removeExtracted } from "./zip.ts";

export interface SourceManifest {
  files: LocalFile[];
  excluded: Excluded[];
  totalBytes: number;
  /** Git chose the files (with or without `--ref`). */
  chosenBy: "git" | "folder";
  origin: SourceOrigin | undefined;
  /** Files that are Git LFS pointers instead of their content. */
  lfsPointers: string[];
  /** Temporary folder of expanded files; `discardManifest` removes it. */
  temporary?: string | undefined;
}

export interface SourceOptions {
  ref?: string | undefined;
  /**
   * The owner's storage (`plan.limits.accountBytes` of the usage endpoint), which sources can
   * never exceed; the free plan's when not given.
   */
  maxBytes?: number | undefined;
  /** Runs git; injected by tests. */
  git?: Git | undefined;
}

/** Git LFS pointer files start with this line and are under 1024 bytes. */
const LFS_POINTER = Buffer.from("version https://git-lfs.github.com/spec/v1");
const LFS_POINTER_MAX = 1024;

export async function buildSourceManifest(
  input: string,
  options: SourceOptions = {},
): Promise<SourceManifest> {
  const root = resolve(input);
  const maxBytes = options.maxBytes ?? PLANS.free.limits.accountBytes;
  const info = await lstatOrFail(root, input);
  if (info.isSymbolicLink()) throw new CliError("invalid_input", messages.errors.symlink(input));
  if (!info.isFile() && !info.isDirectory()) {
    throw new CliError("invalid_input", messages.errors.specialFile(input));
  }
  const git = options.git ?? gitRunner();
  const repository = info.isDirectory() ? await repositoryOf(git, root) : undefined;
  if (options.ref !== undefined && !repository) {
    throw new CliError("invalid_input", messages.errors.refNeedsGit(input));
  }

  const excluded: Excluded[] = [];
  let found: Candidate[];
  let temporary: string | undefined;
  let origin: SourceOrigin | undefined;
  let chosenBy: SourceManifest["chosenBy"] = "folder";

  if (info.isFile()) {
    const reason = exclusionOf(basename(root));
    if (reason) throw new CliError("invalid_input", messages.errors.excludedFile(input, reason));
    if (isZipPath(root)) {
      const zip = await extractZip(root, input, {
        maxBytes,
        exclude: (path) => excludedPrefix(path, "all"),
      });
      temporary = zip.directory;
      found = stripSharedFolder(zip.files);
      excluded.push(...(zip.excluded as Excluded[]));
    } else {
      found = [{ path: basename(root), source: root }];
    }
  } else if (repository && options.ref !== undefined) {
    chosenBy = "git";
    const commit = await resolveCommit(git, root, options.ref);
    if (!commit) throw new CliError("invalid_input", messages.errors.refNotCommit(options.ref));
    // Read before expanding, so a failure here cannot leave the expanded tree behind.
    origin = await originOf(git, root, { ref: options.ref, commit });
    const archiveFolder = await mkdtemp(join(tmpdir(), "portifact-git-"));
    try {
      const archive = join(archiveFolder, "tree.zip");
      if (!(await archiveTree(git, repository, commit, archive))) {
        throw new CliError("invalid_input", messages.errors.refMissingFolder(input, options.ref));
      }
      // Git chose the files, so only the secret filter applies.
      const zip = await extractZip(archive, `${input} at ${options.ref}`, {
        maxBytes,
        exclude: (path) => excludedPrefix(path, "secret"),
      });
      temporary = zip.directory;
      found = zip.files;
      excluded.push(...(zip.excluded as Excluded[]));
    } finally {
      await removeExtracted(archiveFolder);
    }
  } else if (repository) {
    chosenBy = "git";
    const tracked = await trackedFiles(git, root);
    found = [];
    const secrets = new Set<string>();
    for (const path of tracked.files) {
      const secret = excludedPrefix(path, "secret");
      if (secret) {
        if (!secrets.has(secret.path)) excluded.push(secret);
        secrets.add(secret.path);
        continue;
      }
      const source = join(root, path);
      const entry = await lstatOrNull(source);
      // Deleted in the work tree but still versioned: there is nothing to attach.
      if (!entry) continue;
      if (entry.isSymbolicLink())
        throw new CliError("invalid_input", messages.errors.symlink(path));
      if (!entry.isFile()) throw new CliError("invalid_input", messages.errors.specialFile(path));
      found.push({ path, source });
    }
    for (const path of tracked.submodules) excluded.push({ path, reason: "submodule" });
    origin = await originOf(git, root);
  } else {
    found = [];
    await walk(root, "", found, excluded);
  }

  try {
    if (found.length === 0)
      throw new CliError("invalid_input", messages.errors.emptySources(input));
    if (found.length > LIMITS.filesPerVersion) {
      throw new CliError("quota_exceeded", messages.errors.tooManyFiles(LIMITS.filesPerVersion));
    }
    const hashed = await hashCandidates(found, maxBytes, contentTypeOf);
    const lfsPointers: string[] = [];
    for (const file of hashed.files) {
      if (file.size < LFS_POINTER_MAX && (await startsWith(file.source, LFS_POINTER))) {
        lfsPointers.push(file.path);
      }
    }
    return { ...hashed, excluded, chosenBy, origin, lfsPointers, temporary };
  } catch (error) {
    if (temporary) await removeExtracted(temporary);
    throw error;
  }
}

async function lstatOrNull(path: string) {
  try {
    return await lstatOrFail(path, path);
  } catch {
    return null;
  }
}

async function startsWith(path: string, prefix: Buffer): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(prefix.length);
    const { bytesRead } = await handle.read(buffer, 0, prefix.length, 0);
    return bytesRead === prefix.length && buffer.equals(prefix);
  } finally {
    await handle.close();
  }
}
