import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OAuthScope } from "@portifact/contracts";
import { run } from "../cli.ts";
import { KEYRING_SERVICE } from "../credentials.ts";
import { nodeFileBody, type Runtime, type SecretsApi } from "../runtime.ts";
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
  /** URLs the CLI asked to open in a browser. */
  opened: string[];
  /** Questions the CLI asked at the terminal. */
  prompts: string[];
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
  secrets?: FakeSecrets | undefined;
  interactive?: boolean;
  browserOpens?: boolean;
  /** Answers to confirmation prompts, in order; without it nobody can answer a prompt. */
  answers?: string[];
  env?: Record<string, string>;
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), "portifact-cli-"));
  const configDir = join(base, "config", "portifact");
  const workspace = join(base, "work");
  const sleeps: number[] = [];
  const opened: string[] = [];
  const prompts: string[] = [];
  const answers = options.answers;
  let clock = Date.parse("2026-11-08T12:00:00Z");
  const secrets = "secrets" in options ? options.secrets : new FakeSecrets();

  const runtime: Runtime = {
    env: { PORTIFACT_APP_ORIGIN: options.server.origin, ...options.env },
    fetch: (input, init) => fetch(input, init),
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
  };
  // Upload URLs expire on the same controlled clock the CLI reads.
  options.server.clock = () => clock;

  return {
    runtime,
    sleeps,
    opened,
    prompts,
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
