import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Readable } from "node:stream";
import { type Git, gitRunner } from "./git.ts";

/** Output sinks, injected so the CLI can be tested without touching the process streams. */
export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** The shape of `Bun.secrets`: the OS credential store (Keychain, libsecret, Credential Manager). */
export interface SecretsApi {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
}

export type RequestBody = NonNullable<RequestInit["body"]>;

/** Everything the commands take from the outside world, injected so tests control it. */
export interface Runtime {
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Resolves true when a browser was launched. */
  openBrowser: (url: string) => Promise<boolean>;
  /** Undefined when the CLI does not run on Bun, which provides the OS credential store. */
  secrets: SecretsApi | undefined;
  /** Directory for the fallback credentials file. */
  configDir: string;
  /** A person is at the terminal, so opening a browser makes sense. */
  interactive: boolean;
  /**
   * Asks the person at the terminal and resolves their answer. Undefined when nobody can answer
   * (stdin is not a terminal, or CI), so commands that need a confirmation ask for a flag instead.
   */
  prompt: ((question: string) => Promise<string>) | undefined;
  /**
   * A request body that streams a file from disk, so large files are not read into memory. With
   * `range`, only bytes `[start, end)`, for one part of a multipart upload.
   */
  fileBody: (path: string, range?: ByteRange) => RequestBody;
  /** Runs the `git` binary; `pull --git` and git-aware `publish --source` use it. */
  git: Git;
  /** Runs other local programs, such as GitHub CLI's read-only checks after a publish. */
  process: ProcessRunner;
}

export interface ProcessResult {
  code: number;
  /** Standard output as UTF-8, cut at `PROCESS_OUTPUT_LIMIT` bytes. */
  stdout: string;
}

export interface ProcessOptions {
  /** The program is killed and the call rejects after this many milliseconds. */
  timeoutMs: number;
  /** Extra environment variables. */
  env?: Readonly<Record<string, string>> | undefined;
}

/**
 * Runs `command` with `args` as a child process, never through a shell. Rejects when the program
 * cannot start (for example, it is not installed) or runs past the timeout.
 */
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: ProcessOptions,
) => Promise<ProcessResult>;

export const PROCESS_OUTPUT_LIMIT = 64 * 1024;

export interface ByteRange {
  start: number;
  /** Exclusive. */
  end: number;
}

interface BunFileApi {
  file(path: string): Blob;
}

export function defaultRuntime(): Runtime {
  const env = process.env;
  return {
    env,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    openBrowser: (url) => {
      const [command, args] = browserCommand(process.platform, url);
      return launchDetached(command, args);
    },
    secrets: (globalThis as { Bun?: { secrets?: SecretsApi } }).Bun?.secrets,
    configDir: defaultConfigDir(process.platform, env, homedir()),
    interactive: Boolean(process.stderr.isTTY) && !env.CI,
    prompt: process.stdin.isTTY && process.stderr.isTTY && !env.CI ? promptOnTerminal : undefined,
    fileBody: (path, range) => {
      // Bun sends a file (or a lazy slice of it) with its length and without copying it
      // through JavaScript.
      const bun = (globalThis as { Bun?: BunFileApi }).Bun;
      if (!bun) return nodeFileBody(path, range);
      const file = bun.file(path);
      return range ? file.slice(range.start, range.end) : file;
    },
    git: gitRunner(),
    process: runProcess,
  };
}

export const runProcess: ProcessRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...options.env },
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (size >= PROCESS_OUTPUT_LIMIT) return;
      chunks.push(chunk.subarray(0, PROCESS_OUTPUT_LIMIT - size));
      size += chunk.length;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });

/** Streams a file as a request body on Node, where tests run. */
export function nodeFileBody(path: string, range?: ByteRange): RequestBody {
  const stream = range
    ? createReadStream(path, { start: range.start, end: range.end - 1 })
    : createReadStream(path);
  return Readable.toWeb(stream) as RequestBody;
}

async function promptOnTerminal(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

export function defaultConfigDir(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  if (platform === "win32")
    return join(env.APPDATA || join(home, "AppData", "Roaming"), "portifact");
  if (platform === "darwin") return join(home, "Library", "Application Support", "portifact");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "portifact");
}

// The URL is passed as a single argument, never through a shell, so it cannot inject commands.
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

export function launchDetached(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
