import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { notice, run, version } from "./cli.ts";
import { defaultRuntime } from "./runtime.ts";

async function invoke(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

describe("portifact cli", () => {
  it("reports the version from its package manifest", async () => {
    expect(version).toBe(packageJson.version);

    for (const flag of ["--version", "-v"]) {
      const result = await invoke(flag);
      expect(result).toEqual({ code: 0, stdout: `${packageJson.version}\n`, stderr: "" });
    }
  });

  it("prints usage with the program name and options on --help", async () => {
    const result = await invoke("--help");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: portifact");
    expect(result.stdout).toContain("-v, --version");
    expect(result.stdout).toContain("-h, --help");
    for (const command of ["login", "logout", "whoami"]) {
      expect(result.stdout).toMatch(new RegExp(`^  ${command} `, "m"));
    }
    expect(result.stderr).toBe("");
  });

  it("documents --json and --no-browser in the help of each command", async () => {
    const login = await invoke("login", "--help");
    expect(login.code).toBe(0);
    expect(login.stdout).toContain("--no-browser");
    expect(login.stdout).toContain("--json");
    for (const command of ["logout", "whoami"]) {
      expect((await invoke(command, "--help")).stdout).toContain("--json");
    }
  });

  it("fails with the usage exit code on an unknown command option", async () => {
    const result = await invoke("whoami", "--nope");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown option '--nope'");
  });

  it("fails with the usage exit code when the server override is not a safe origin", async () => {
    const out: string[] = [];
    const code = await run(
      ["whoami", "--json"],
      { stdout: (text) => out.push(text), stderr: () => {} },
      { ...defaultRuntime(), env: { PORTIFACT_APP_ORIGIN: "http://staging.example" } },
    );
    expect(code).toBe(2);
    expect(JSON.parse(out.join("")).error.code).toBe("invalid_input");
  });

  it("rethrows unexpected errors from a command", async () => {
    // The keyring passes the availability probe, then fails while reading the credentials.
    const secrets = {
      get: async ({ name }: { name: string }) => {
        if (name === "https://app.portifact.com") throw new RangeError("keyring broke");
        return null;
      },
      set: async () => {},
      delete: async () => false,
    };
    const runtime = { ...defaultRuntime(), env: {}, secrets };
    await expect(run(["whoami"], { stdout: () => {}, stderr: () => {} }, runtime)).rejects.toThrow(
      "keyring broke",
    );
  });

  it("explains the development status when run without arguments", async () => {
    const result = await invoke();

    expect(result).toEqual({ code: 0, stdout: notice, stderr: "" });
    expect(notice).toContain("early development");
    expect(notice).toContain("portifact login");
  });

  it("fails with the usage exit code and an error on unknown options", async () => {
    const result = await invoke("--does-not-exist");

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown option '--does-not-exist'");
  });

  it("rethrows errors that are not command line errors", async () => {
    const failingIo = {
      stdout: () => {
        throw new Error("stdout closed");
      },
      stderr: () => {},
    };

    await expect(run([], failingIo)).rejects.toThrow("stdout closed");
  });
});
