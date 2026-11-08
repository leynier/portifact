import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../cli.ts";
import type { Runtime, SecretsApi } from "../runtime.ts";
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
  secrets: FakeSecrets | undefined;
  configDir: string;
  /** Moves the controlled clock forward. */
  advance(ms: number): void;
  invoke(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  server: FakeServer;
  secrets?: FakeSecrets | undefined;
  interactive?: boolean;
  browserOpens?: boolean;
  env?: Record<string, string>;
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const configDir = join(await mkdtemp(join(tmpdir(), "portifact-cli-")), "config", "portifact");
  const sleeps: number[] = [];
  const opened: string[] = [];
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
  };

  return {
    runtime,
    sleeps,
    opened,
    secrets,
    configDir,
    advance(ms) {
      clock += ms;
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
    cleanup: () => rm(join(configDir, "..", ".."), { recursive: true, force: true }),
  };
}
