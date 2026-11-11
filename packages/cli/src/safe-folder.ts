// Writing inside one folder without ever leaving it (`portifact export`, decision 0022). The
// folder may hold anything a previous run, the user or another program left there, links
// included, so every step refuses to follow one: each folder on the way down is checked with
// `lstat` and created one level at a time, new files are created exclusively (`wx`, and
// `O_NOFOLLOW` where the platform has it) under names no artifact path can take, and a file is
// put in place with `rename`, which replaces a name and never writes through it. A file counts as
// written only once it is read back from its final place and matches its size and SHA-256.
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";

/** Where files are written before they are put in place: a name artifact paths never reach. */
export const TEMP_FOLDER = ".portifact-tmp";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const CREATE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;

export class SafeFolder {
  private constructor(readonly root: string) {}

  /**
   * The folder, created if needed, by its real path, so every later check compares against it.
   * Nothing is written into it here: the caller claims it first (`claimFolder` in `export.ts`).
   */
  static async open(path: string): Promise<SafeFolder> {
    await mkdir(path, { recursive: true });
    return new SafeFolder(await realpath(path));
  }

  /**
   * The folder at `segments` under the root, each level refused if it is a link or not a folder,
   * and its real path must still be inside the root. With `create` (the default) a missing level
   * is created; without it a missing level answers null, for reads that must not create anything.
   */
  async directory(segments: readonly string[], create: true): Promise<string>;
  async directory(segments: readonly string[], create?: boolean): Promise<string | null>;
  async directory(segments: readonly string[], create = true): Promise<string | null> {
    let current = this.root;
    for (const segment of segments) {
      current = join(current, segment);
      let info: Awaited<ReturnType<typeof lstat>> | null = null;
      try {
        info = await lstat(current);
      } catch {
        info = null;
      }
      if (info === null) {
        if (!create) return null;
        try {
          await mkdir(current);
        } catch {
          info = await lstat(current);
        }
      }
      if (info !== null && (info.isSymbolicLink() || !info.isDirectory())) {
        throw new CliError("invalid_input", messages.exportSpace.notAFolder(this.show(current)));
      }
    }
    const real = await realpath(current);
    if (real !== this.root && !real.startsWith(`${this.root}${sep}`)) {
      throw new CliError("invalid_input", messages.exportSpace.notAFolder(this.show(current)));
    }
    return current;
  }

  /** A new, empty temporary file no other run or artifact path can share, open for writing. */
  async temporary() {
    const path = join(this.root, TEMP_FOLDER, randomUUID());
    const handle = await open(path, CREATE_NEW, 0o644);
    return { path, handle };
  }

  /**
   * Puts `temporary` at `segments` (a file under the root), replacing what is there only when it
   * is a regular file: a link, a folder or anything else at that name is refused.
   */
  async place(temporary: string, segments: readonly string[]): Promise<string> {
    const folder = await this.directory(segments.slice(0, -1), true);
    const target = join(folder, segments.at(-1) as string);
    const existing = await info(target);
    if (existing !== null && !existing.isFile()) {
      await rm(temporary, { force: true });
      throw new CliError("invalid_input", messages.exportSpace.notAFile(this.show(target)));
    }
    await rename(temporary, target);
    return target;
  }

  /**
   * The regular file at `segments`, reached only through folders `directory` accepts (no link at
   * any level, real path inside the root), or null when there is none. Every read the export
   * trusts goes through it, so a link planted at a parent folder is refused, never followed.
   */
  private async file(segments: readonly string[]): Promise<string | null> {
    const folder = await this.directory(segments.slice(0, -1), false);
    if (folder === null) return null;
    const target = join(folder, segments.at(-1) as string);
    const found = await info(target);
    if (found === null) return null;
    if (!found.isFile()) {
      throw new CliError("invalid_input", messages.exportSpace.notAFile(this.show(target)));
    }
    return target;
  }

  /** Whether `segments` names a regular file (never through a link) with this size and SHA-256. */
  async holds(segments: readonly string[], size: number, sha256: string): Promise<boolean> {
    const target = await this.file(segments);
    if (target === null || (await lstat(target)).size !== size) return false;
    return (await digest(target)) === sha256;
  }

  /** Removes the regular file at `segments` if there is one (never through a link). */
  async remove(segments: readonly string[]): Promise<void> {
    const target = await this.file(segments);
    if (target !== null) await rm(target, { force: true });
  }

  /** Writes `text` at `segments` through a temporary file. */
  async writeText(segments: readonly string[], text: string): Promise<void> {
    const { path, handle } = await this.temporary();
    try {
      await handle.write(text);
    } finally {
      await handle.close();
    }
    await this.place(path, segments);
  }

  /** Reads a regular file at `segments` (never through a link), or null when there is none. */
  async readText(segments: readonly string[]): Promise<string | null> {
    const target = await this.file(segments);
    if (target === null) return null;
    const handle = await open(target, constants.O_RDONLY | NOFOLLOW);
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  /** Removes the temporary folder's leftovers from interrupted runs. */
  async clearTemporary(): Promise<void> {
    // `rm` removes a link planted at this name, never what it points to.
    await rm(join(this.root, TEMP_FOLDER), { recursive: true, force: true });
    await this.directory([TEMP_FOLDER], true);
  }

  private show(path: string): string {
    return relative(this.root, path) || ".";
  }
}

async function info(path: string) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

/** The SHA-256 of a file read from disk as a stream, never through a link. */
export async function digest(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream("", { fd: handle.fd, autoClose: false })) {
      hash.update(chunk as Buffer);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}
