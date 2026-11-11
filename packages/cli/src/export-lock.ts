// The lock that keeps two `portifact export` runs out of one folder (decision 0022). It is a file
// created exclusively (`wx`, never through a link) holding this run's process ID, host and a
// random token. A run removes it when it ends, also on Ctrl-C or `kill` (the command's signal
// handler). A lock whose process no longer runs on this host was left by a run that was killed
// outright: it is taken over by moving it aside under a name of our own (an atomic `rename`, so
// of two runs that try at once only one moves it), checking it is the dead run's, and creating a
// new one exclusively. A lock of another host, a live process, an unreadable lock or anything
// that is not a regular file at that name is never taken over or deleted.
import { randomUUID } from "node:crypto";
import { constants, lstatSync, readFileSync, rmSync } from "node:fs";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";

export const EXPORT_LOCK = ".portifact-export.lock";

const CREATE_NEW =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

interface LockRecord {
  pid: number;
  host: string;
  token: string;
}

export interface ExportLock {
  /** Removes the lock if it is still this run's (async, at the end of a run). */
  release(): Promise<void>;
  /** The same, synchronously, for a signal handler that exits right after. */
  releaseNow(): void;
}

function parse(text: string): LockRecord | null {
  try {
    const value = JSON.parse(text) as Partial<LockRecord>;
    return typeof value.pid === "number" &&
      typeof value.host === "string" &&
      typeof value.token === "string"
      ? { pid: value.pid, host: value.host, token: value.token }
      : null;
  } catch {
    return null;
  }
}

async function create(path: string, record: LockRecord): Promise<boolean> {
  try {
    const handle = await open(path, CREATE_NEW, 0o644);
    try {
      await handle.write(`${JSON.stringify(record)}\n`);
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Takes the folder's lock, or refuses with `folder_in_use` naming what to do. */
export async function takeExportLock(
  root: string,
  out: string,
  processAlive: (pid: number) => boolean,
): Promise<ExportLock> {
  const path = join(root, EXPORT_LOCK);
  const mine: LockRecord = { pid: process.pid, host: hostname(), token: randomUUID() };
  const locked = () => new CliError("folder_in_use", messages.exportSpace.locked(out, EXPORT_LOCK));
  if (!(await create(path, mine))) {
    const existing = await lstat(path);
    if (!existing.isFile()) throw locked();
    const record = parse(await readFile(path, "utf8").catch(() => ""));
    if (record === null || record.host !== mine.host || processAlive(record.pid)) throw locked();
    // A dead run's lock: move it aside atomically, check it is still that run's, then lock anew.
    const aside = join(root, `${EXPORT_LOCK}.stale-${mine.token}`);
    try {
      await rename(path, aside);
    } catch {
      throw locked();
    }
    const moved = parse(await readFile(aside, "utf8").catch(() => ""));
    if (moved?.token !== record.token) {
      // Another run replaced it in between: put it back, untouched, and refuse.
      await rename(aside, path).catch(() => undefined);
      throw locked();
    }
    await rm(aside, { force: true });
    if (!(await create(path, mine))) throw locked();
  }
  const isMine = (text: string) => parse(text)?.token === mine.token;
  return {
    async release() {
      const text = await readFile(path, "utf8").catch(() => "");
      if (isMine(text) && (await lstat(path)).isFile()) await rm(path, { force: true });
    },
    releaseNow() {
      try {
        if (lstatSync(path).isFile() && isMine(readFileSync(path, "utf8"))) rmSync(path);
      } catch {
        // Already gone.
      }
    },
  };
}
