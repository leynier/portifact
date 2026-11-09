import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessRunner } from "./runtime.ts";
import { GH_TIMEOUT_MS, STAR_FLAG_FILE } from "./star.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness, type HarnessOptions } from "./testing/harness.ts";

const MESSAGE =
  "Enjoying Portifact? A GitHub star helps other people find it. If you want to, run: gh repo star leynier/portifact";
const AUTH = ["gh", "auth", "status", "--hostname", "github.com"];
const STARRED = ["gh", "api", "--silent", "--include", "user/starred/leynier/portifact"];

interface GhOptions {
  /** Exit code of `gh auth status`. */
  auth?: number;
  /** What `gh api user/starred/...` answers: an HTTP status, or a failure to run. */
  starred?: 204 | 404 | 500 | "timeout";
}

/** A GitHub CLI that answers the two read-only checks and refuses anything else. */
function fakeGh({ auth = 0, starred = 404 }: GhOptions = {}): ProcessRunner {
  return async (command, args, options) => {
    expect(command).toBe("gh");
    expect(options.timeoutMs).toBe(GH_TIMEOUT_MS);
    expect(options.env?.GH_PROMPT_DISABLED).toBe("1");
    const call = [command, ...args].join(" ");
    if (call === AUTH.join(" ")) return { code: auth, stdout: "" };
    if (call === STARRED.join(" ")) {
      if (starred === "timeout") throw new Error("gh timed out");
      const reason = { 204: "No Content", 404: "Not Found", 500: "Internal Server Error" }[starred];
      return {
        code: starred === 204 ? 0 : 1,
        stdout: `HTTP/2.0 ${starred} ${reason}\r\nAccess-Control-Allow-Origin: *\r\n\r\n`,
      };
    }
    throw new Error(`unexpected command: ${call}`);
  };
}

let server: FakeServer;
let h: Harness;

beforeEach(async () => {
  server = await startFakeServer();
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

async function harness(options: Omit<HarnessOptions, "server"> = {}) {
  h = await createHarness({ server, ...options });
  h.signIn();
  return h.files("site", { "index.html": "<h1>Report</h1>" });
}

async function flag(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(h.configDir, STAR_FLAG_FILE), "utf8"));
  } catch {
    return undefined;
  }
}

describe("star suggestion after publishing", () => {
  it("is shown once, after the first publish, when gh is signed in and the repository is not starred", async () => {
    const folder = await harness({ process: fakeGh() });

    const first = await h.invoke("publish", folder);

    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/^Published version 1 of /);
    expect(first.stdout).not.toContain("star");
    expect(first.stderr.endsWith(`\n\n${MESSAGE}\n`)).toBe(true);
    expect(h.processes).toEqual([AUTH, STARRED]);
    expect(await flag()).toEqual({ version: 1, state: "shown", at: "2026-11-08T12:00:00.000Z" });
    if (process.platform !== "win32") {
      const { mode } = await stat(join(h.configDir, STAR_FLAG_FILE));
      expect(mode & 0o777).toBe(0o600);
    }

    const second = await h.invoke("publish", folder);

    expect(second.code).toBe(0);
    expect(second.stderr).not.toContain("GitHub star");
    // Once shown, the CLI does not even ask gh again.
    expect(h.processes).toEqual([AUTH, STARRED]);
  });

  it("never stars or writes anything through gh: it runs only the two read-only checks", async () => {
    const folder = await harness({ process: fakeGh() });

    await h.invoke("publish", folder);
    await h.invoke("publish", folder, "--json");

    expect(h.processes).toEqual([AUTH, STARRED]);
    for (const call of h.processes) {
      expect(call).not.toContain("star");
      expect(call).not.toContain("repo");
      expect(call).not.toContain("--method");
      expect(call).not.toContain("-X");
    }
  });

  it("adds the suggestion to the JSON result only when it is shown", async () => {
    const folder = await harness({ process: fakeGh() });

    const first = await h.invoke("publish", folder, "--json");

    expect(first.code).toBe(0);
    const result = JSON.parse(first.stdout);
    expect(result.suggestion).toEqual({
      kind: "star_repository",
      message: MESSAGE,
      command: ["gh", "repo", "star", "leynier/portifact"],
    });
    expect(first.stderr).not.toContain("GitHub star");
    expect(await flag()).toMatchObject({ state: "shown" });

    const second = JSON.parse((await h.invoke("publish", folder, "--json")).stdout);
    expect(second).not.toHaveProperty("suggestion");
    expect(second.versionNumber).toBe(1);
  });

  it("is not shown when the user already starred the repository, and is not checked again", async () => {
    const folder = await harness({ process: fakeGh({ starred: 204 }) });

    const first = await h.invoke("publish", folder, "--json");

    expect(JSON.parse(first.stdout)).not.toHaveProperty("suggestion");
    expect(await flag()).toMatchObject({ state: "starred" });
    await h.invoke("publish", folder);
    expect(h.processes).toEqual([AUTH, STARRED]);
  });

  it("is not shown, and stays possible later, when gh is not installed", async () => {
    const folder = await harness();

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("GitHub star");
    expect(h.processes).toEqual([AUTH]);
    expect(await flag()).toBeUndefined();
  });

  it("is not shown when gh is not signed in to GitHub", async () => {
    const folder = await harness({ process: fakeGh({ auth: 1 }) });

    const result = await h.invoke("publish", folder, "--json");

    expect(JSON.parse(result.stdout)).not.toHaveProperty("suggestion");
    expect(h.processes).toEqual([AUTH]);
    expect(await flag()).toBeUndefined();
  });

  it.each([500, "timeout"] as const)(
    "is not shown when GitHub cannot say whether the repository is starred (%s)",
    async (starred) => {
      const folder = await harness({ process: fakeGh({ starred }) });

      const result = await h.invoke("publish", folder);

      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("GitHub star");
      expect(h.processes).toEqual([AUTH, STARRED]);
      expect(await flag()).toBeUndefined();
    },
  );

  it.each([{ CI: "true" }, { PORTIFACT_NO_STAR_PROMPT: "1" }])(
    "is never checked or shown with %o",
    async (env) => {
      const folder = await harness({ process: fakeGh(), env });

      const result = await h.invoke("publish", folder, "--json");

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).not.toHaveProperty("suggestion");
      expect(h.processes).toEqual([]);
      expect(await flag()).toBeUndefined();
    },
  );

  it("is not shown on a dry run", async () => {
    const folder = await harness({ process: fakeGh() });

    const human = await h.invoke("publish", folder, "--dry-run");
    const json = await h.invoke("publish", folder, "--dry-run", "--json");

    expect(human.stderr).not.toContain("GitHub star");
    expect(JSON.parse(json.stdout)).not.toHaveProperty("suggestion");
    expect(h.processes).toEqual([]);
    expect(await flag()).toBeUndefined();
  });

  it("is not shown when the publish fails", async () => {
    const folder = await harness({ process: fakeGh() });
    server.faults.push({
      method: "POST",
      path: /\/commit$/,
      reply: {
        status: 409,
        body: { error: { code: "upload_incomplete", message: "Some files are missing." } },
      },
    });

    const result = await h.invoke("publish", folder, "--json");

    expect(result.code).toBe(6);
    expect(JSON.parse(result.stdout)).toEqual({
      error: { code: "upload_incomplete", message: "Some files are missing." },
    });
    expect(h.processes).toEqual([]);
    expect(await flag()).toBeUndefined();
  });

  it("is not shown when the flag cannot be read, so it never repeats", async () => {
    const folder = await harness({ process: fakeGh() });
    await mkdir(join(h.configDir, STAR_FLAG_FILE), { recursive: true });

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("GitHub star");
    expect(h.processes).toEqual([]);
  });
});

describe("publish --help", () => {
  it("documents the star suggestion and how to turn it off", async () => {
    h = await createHarness({ server });

    const result = await h.invoke("publish", "--help");

    expect(result.stdout).toContain("never stars for you");
    expect(result.stdout).toContain("PORTIFACT_NO_STAR_PROMPT=1");
    expect(h.processes).toEqual([]);
  });
});
