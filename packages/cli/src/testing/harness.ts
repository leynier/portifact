import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OAuthScope } from "@portifact/contracts";
import { run } from "../cli.ts";
import { KEYRING_SERVICE } from "../credentials.ts";
import { type Git, gitRunner } from "../git.ts";
import {
  nodeFileBody,
  type ProcessRunner,
  processAlive,
  type Runtime,
  type SecretsApi,
  type StopSignal,
} from "../runtime.ts";
import type { FakeServer } from "./fake-server.ts";

/** An in-memory OS credential store, or one that fails like Linux without a Secret Service. */
export class FakeSecrets implements SecretsApi {
  readonly entries = new Map<string, string>();
  constructor(private readonly available = true) {}

  private key(options: { service: string; name: string }): string {
    if (!this.available) throw new Error("No secret service is available");
    return `${options.service}\u0000${options.name}`;
  }

  async get(options: { service: string; name: string }) {
    return this.entries.get(this.key(options)) ?? null;
  }

  async set(options: { service: string; name: string; value: string }) {
    this.entries.set(this.key(options), options.value);
  }

  async delete(options: { service: string; name: string }) {
    return this.entries.delete(this.key(options));
  }
}

export interface Harness {
  runtime: Runtime;
  /** Every delay the CLI asked to wait, in milliseconds. */
  sleeps: number[];
  /** Exit codes the CLI asked for after a stop signal. */
  exits: number[];
  /** Sends a stop signal to the running command, as Ctrl-C or `kill` would. */
  signal: (name: StopSignal) => void;
  /** URLs the CLI asked to open in a browser. */
  opened: string[];
  /** Questions the CLI asked at the terminal. */
  prompts: string[];
  /** Every program the CLI ran through `Runtime.process`, with its arguments. */
  processes: string[][];
  secrets: FakeSecrets | undefined;
  configDir: string;
  /** A scratch folder for files to publish, removed by cleanup. */
  workspace: string;
  /** Moves the controlled clock forward. */
  advance(ms: number): void;
  /** Stores tokens as if `portifact login` had run, with every product scope by default. */
  signIn(scopes?: string[]): void;
  /** Writes files under the workspace and returns the folder's path. */
  files(folder: string, contents: Record<string, string | Buffer>): Promise<string>;
  invoke(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  server: FakeServer;
  /** Whether a process ID runs (for an export lock a stopped run left); real by default. */
  processAlive?: (pid: number) => boolean;
  /** Called before each request the CLI sends (tests act in the middle of a command). */
  beforeFetch?: (url: string) => void;
  secrets?: FakeSecrets | undefined;
  interactive?: boolean;
  browserOpens?: boolean;
  /** Answers to confirmation prompts, in order; without it nobody can answer a prompt. */
  answers?: string[];
  env?: Record<string, string>;
  /** Runs git; the real binary by default. */
  git?: Git;
  /** Runs other programs; by default none is installed, so no test reaches the real `gh`. */
  process?: ProcessRunner;
}

/** A runner for which no program is installed, like `spawn` failing with ENOENT. */
export const nothingInstalled: ProcessRunner = async (command) => {
  throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
};

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), "portifact-cli-"));
  const configDir = join(base, "config", "portifact");
  const workspace = join(base, "work");
  const sleeps: number[] = [];
  const exits: number[] = [];
  const signalListeners = new Set<(signal: StopSignal) => void>();
  const opened: string[] = [];
  const prompts: string[] = [];
  const processes: string[][] = [];
  const runProcess = options.process ?? nothingInstalled;
  const answers = options.answers;
  let clock = Date.parse("2026-11-08T12:00:00Z");
  const secrets = "secrets" in options ? options.secrets : new FakeSecrets();

  const runtime: Runtime = {
    env: { PORTIFACT_APP_ORIGIN: options.server.origin, ...options.env },
    fetch: (input, init) => {
      options.beforeFetch?.(String(input));
      return fetch(input, init);
    },
    now: () => clock,
    // Waiting is simulated: the clock jumps instead of real time passing.
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    openBrowser: async (url) => {
      opened.push(url);
      return options.browserOpens ?? true;
    },
    secrets,
    configDir,
    interactive: options.interactive ?? false,
    prompt: answers
      ? async (question) => {
          prompts.push(question);
          return answers.shift() ?? "";
        }
      : undefined,
    fileBody: nodeFileBody,
    git: options.git ?? gitRunner(),
    process: (command, args, processOptions) => {
      processes.push([command, ...args]);
      return runProcess(command, args, processOptions);
    },
    onSignal: (listener) => {
      signalListeners.add(listener);
      return () => signalListeners.delete(listener);
    },
    // The test process keeps running: the code is recorded instead.
    exit: (code) => {
      exits.push(code);
    },
    processAlive: (pid) => (options.processAlive ? options.processAlive(pid) : processAlive(pid)),
  };
  // Upload URLs expire on the same controlled clock the CLI reads.
  options.server.clock = () => clock;

  return {
    runtime,
    sleeps,
    exits,
    signal: (name: StopSignal) => {
      for (const listener of [...signalListeners]) listener(name);
    },
    opened,
    prompts,
    processes,
    secrets,
    configDir,
    workspace,
    advance(ms) {
      clock += ms;
    },
    signIn(scopes = [...OAuthScope.options, "offline_access"]) {
      const pair = options.server.issue(scopes);
      secrets?.entries.set(
        `${KEYRING_SERVICE}\u0000${options.server.origin}`,
        JSON.stringify({
          accessToken: pair.accessToken,
          refreshToken: pair.refreshToken,
          expiresAt: clock + 3_600_000,
          scopes,
        }),
      );
    },
    async files(folder, contents) {
      const root = join(workspace, folder);
      await mkdir(root, { recursive: true });
      for (const [path, content] of Object.entries(contents)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
      }
      return root;
    },
    async invoke(...argv) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(
        argv,
        { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
        runtime,
      );
      return { code, stdout: out.join(""), stderr: err.join("") };
    },
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}
