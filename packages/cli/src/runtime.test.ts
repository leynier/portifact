import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exitCodeFor } from "./errors.ts";
import {
  browserCommand,
  defaultConfigDir,
  defaultRuntime,
  launchDetached,
  nodeFileBody,
  PROCESS_OUTPUT_LIMIT,
  runProcess,
} from "./runtime.ts";

describe("defaultConfigDir", () => {
  it("follows each platform's convention", () => {
    expect(defaultConfigDir("linux", {}, "/home/ada")).toBe(
      join("/home/ada", ".config", "portifact"),
    );
    expect(defaultConfigDir("linux", { XDG_CONFIG_HOME: "/xdg" }, "/home/ada")).toBe(
      join("/xdg", "portifact"),
    );
    expect(defaultConfigDir("darwin", {}, "/Users/ada")).toBe(
      join("/Users/ada", "Library", "Application Support", "portifact"),
    );
    expect(defaultConfigDir("win32", { APPDATA: "C:/Users/ada/AppData/Roaming" }, "C:/x")).toBe(
      join("C:/Users/ada/AppData/Roaming", "portifact"),
    );
    expect(defaultConfigDir("win32", {}, "C:/Users/ada")).toBe(
      join("C:/Users/ada", "AppData", "Roaming", "portifact"),
    );
  });
});

describe("browserCommand", () => {
  it("passes the URL as one argument, never through a shell", () => {
    const url = "https://app.portifact.com/device?user_code=A&b=$(rm)";
    expect(browserCommand("darwin", url)).toEqual(["open", [url]]);
    expect(browserCommand("linux", url)).toEqual(["xdg-open", [url]]);
    expect(browserCommand("win32", url)).toEqual([
      "rundll32",
      ["url.dll,FileProtocolHandler", url],
    ]);
  });
});

describe("launchDetached", () => {
  it("resolves true when the program starts and false when it does not exist", async () => {
    expect(await launchDetached(process.execPath, ["-e", ""])).toBe(true);
    expect(await launchDetached("portifact-no-such-browser", [])).toBe(false);
  });
});

describe("runProcess", () => {
  const node = process.execPath;

  it("passes arguments without a shell and returns the exit code and standard output", async () => {
    const result = await runProcess(
      node,
      [
        "-e",
        "process.stdout.write(process.argv[1] + process.env.PF_TEST); process.exit(3)",
        "$(x)",
      ],
      { timeoutMs: 10_000, env: { PF_TEST: "!" } },
    );
    expect(result).toEqual({ code: 3, stdout: "$(x)!" });
  });

  it("keeps at most the output limit", async () => {
    const result = await runProcess(
      node,
      ["-e", `process.stdout.write("a".repeat(${PROCESS_OUTPUT_LIMIT + 10}))`],
      { timeoutMs: 10_000 },
    );
    expect(result.stdout).toHaveLength(PROCESS_OUTPUT_LIMIT);
  });

  it("rejects when the program is not installed or runs past the timeout", async () => {
    await expect(
      runProcess("portifact-no-such-program", [], { timeoutMs: 10_000 }),
    ).rejects.toThrow();
    await expect(
      runProcess(node, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 100 }),
    ).rejects.toThrow("timed out");
  });
});

describe("defaultRuntime", () => {
  it("reads the process environment and has no OS credential store outside Bun", async () => {
    const runtime = defaultRuntime();
    expect(runtime.env).toBe(process.env);
    expect(runtime.secrets).toBeUndefined();
    expect(runtime.process).toBe(runProcess);
    const before = runtime.now();
    await runtime.sleep(1);
    expect(runtime.now()).toBeGreaterThanOrEqual(before);
  });

  it("cannot prompt when stdin is not a terminal, as under a test runner or in CI", () => {
    expect(process.stdin.isTTY).toBeFalsy();
    expect(defaultRuntime().prompt).toBeUndefined();
  });

  it("streams a file as a request body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "portifact-body-"));
    try {
      await writeFile(join(dir, "a.txt"), "streamed bytes");
      const body = defaultRuntime().fileBody(join(dir, "a.txt"));
      expect(await new Response(body).text()).toBe("streamed bytes");
      const slice = defaultRuntime().fileBody(join(dir, "a.txt"), { start: 9, end: 14 });
      expect(await new Response(slice).text()).toBe("bytes");
      const head = nodeFileBody(join(dir, "a.txt"), { start: 0, end: 8 });
      expect(await new Response(head).text()).toBe("streamed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("exitCodeFor", () => {
  it("maps each error code to its documented exit code", () => {
    expect(exitCodeFor("invalid_input")).toBe(2);
    expect(exitCodeFor("unauthenticated")).toBe(3);
    expect(exitCodeFor("authorization_denied")).toBe(4);
    expect(exitCodeFor("authorization_expired")).toBe(4);
    expect(exitCodeFor("network_error")).toBe(1);
    expect(exitCodeFor("server_error")).toBe(1);
    expect(exitCodeFor("rate_limited")).toBe(1);
    expect(exitCodeFor("capacity_unavailable")).toBe(1);
    expect(exitCodeFor("upload_failed")).toBe(1);
    expect(exitCodeFor("cancelled")).toBe(1);
    expect(exitCodeFor("not_found")).toBe(5);
    expect(exitCodeFor("forbidden")).toBe(5);
    expect(exitCodeFor("version_conflict")).toBe(6);
    expect(exitCodeFor("upload_incomplete")).toBe(6);
    expect(exitCodeFor("artifact_archived")).toBe(6);
    expect(exitCodeFor("quota_exceeded")).toBe(7);
    expect(exitCodeFor("traffic_exceeded")).toBe(7);
    expect(exitCodeFor("account_too_new_for_public")).toBe(7);
    expect(exitCodeFor("human_verification_required")).toBe(7);
    expect(exitCodeFor("plan_required")).toBe(7);
  });
});
