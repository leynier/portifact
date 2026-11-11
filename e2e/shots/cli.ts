// Runs the real portifact CLI (packages/cli) against the e2e stack, in this process, so the
// landing page's terminal blocks show what the CLI actually prints. Requests to the app go to the
// stack's HTTPS front end with the app host, and presigned uploads go to the control host's R2
// stand-in, as in the load test.

import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../packages/cli/src/cli.ts";
import { defaultRuntime, type Runtime, type SecretsApi } from "../../packages/cli/src/runtime.ts";
import { APP_HOST, APP_ORIGIN } from "../src/hosts.ts";

const BUCKET = "portifact-e2e";

class MemorySecrets implements SecretsApi {
  private readonly entries = new Map<string, string>();
  async get(options: { service: string; name: string }) {
    return this.entries.get(`${options.service}\u0000${options.name}`) ?? null;
  }
  async set(options: { service: string; name: string; value: string }) {
    this.entries.set(`${options.service}\u0000${options.name}`, options.value);
  }
  async delete(options: { service: string; name: string }) {
    return this.entries.delete(`${options.service}\u0000${options.name}`);
  }
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("the e2e stack is not running (global-setup.ts)");
  return value;
}

/** Sends one request as raw HTTP(S) and answers like `fetch`. */
function send(
  target: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
): Promise<Response> {
  const requester = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = requester(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers: body ? { ...headers, "content-length": String(body.length) } : headers,
        rejectUnauthorized: false,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          const status = incoming.statusCode ?? 502;
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            for (const item of Array.isArray(value) ? value : value ? [value] : []) {
              responseHeaders.append(name, item);
            }
          }
          const empty = status === 204 || status === 304 || method === "HEAD";
          resolve(
            new Response(empty ? null : Buffer.concat(chunks), {
              status,
              headers: responseHeaders,
            }),
          );
        });
        incoming.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

const stackFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  if (url.host === APP_HOST) {
    const target = new URL(url.pathname + url.search, env("PF_E2E_FRONT"));
    return send(target, request.method, { ...headers, host: APP_HOST }, body);
  }
  // https://<account>.r2.cloudflarestorage.com/<bucket>/<key>?X-Amz-...
  const [bucket, ...key] = url.pathname.split("/").slice(1).map(decodeURIComponent);
  if (bucket !== BUCKET) throw new Error(`unexpected request to ${url.host}`);
  const query = new URLSearchParams({ key: key.join("/"), bucket });
  for (const name of ["uploadId", "partNumber"]) {
    const value = url.searchParams.get(name);
    if (value !== null) query.set(name, value);
  }
  return send(new URL(`/storage?${query}`, env("PF_E2E_CONTROL")), request.method, headers, body);
};

/** One piece of output, in the order a terminal would show it. */
export interface Chunk {
  stream: "stdout" | "stderr";
  text: string;
}

export interface CliRun {
  /** The command line as typed, arguments with spaces quoted. */
  command: string;
  code: number;
  stdout: string;
  output: Chunk[];
}

function quoted(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;
}

export interface Cli {
  /** Runs `portifact <args>` in `cwd`; `command` is how the landing shows it. */
  run(cwd: string, ...args: string[]): Promise<CliRun>;
  /** URLs the CLI asked to open in a browser, such as the device sign-in page. */
  opened: string[];
  close(): void;
}

/** `extraEnv` adds variables to the CLI's environment, such as `PORTIFACT_TOKEN` for a service token. */
export function createCli(extraEnv: Record<string, string> = {}): Cli {
  const configDir = mkdtempSync(join(tmpdir(), "pf-shots-cli-"));
  const opened: string[] = [];
  const runtime: Runtime = {
    ...defaultRuntime(),
    env: { PORTIFACT_APP_ORIGIN: APP_ORIGIN, PORTIFACT_NO_STAR_PROMPT: "1", ...extraEnv },
    fetch: stackFetch,
    openBrowser: async (url) => {
      opened.push(url);
      return true;
    },
    secrets: new MemorySecrets(),
    configDir,
    interactive: true,
    prompt: undefined,
  };
  return {
    opened,
    async run(cwd, ...args) {
      const output: Chunk[] = [];
      const previous = process.cwd();
      process.chdir(cwd);
      try {
        const code = await run(
          args,
          {
            stdout: (text) => {
              output.push({ stream: "stdout", text });
            },
            stderr: (text) => {
              output.push({ stream: "stderr", text });
            },
          },
          runtime,
        );
        const stdout = output
          .filter((chunk) => chunk.stream === "stdout")
          .map((chunk) => chunk.text)
          .join("");
        return { command: ["portifact", ...args].map(quoted).join(" "), code, stdout, output };
      } finally {
        process.chdir(previous);
      }
    },
    close() {
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}
