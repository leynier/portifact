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
    for (const command of [
      "login",
      "logout",
      "whoami",
      "publish",
      "list",
      "info",
      "renew",
      "archive",
      "restore",
      "pin",
      "unpin",
      "diff",
      "delete",
      "access",
    ]) {
      expect(result.stdout).toMatch(new RegExp(`^  ${command} `, "m"));
    }
    expect(result.stdout).toContain("Exit codes:");
    expect(result.stdout).toContain("7  limit reached");
    expect(result.stderr).toBe("");
  });

  it("prints the third-party notices of the binary and points to them from --help", async () => {
    const help = await invoke("--help");
    expect(help.stdout).toMatch(/^ {2}licenses /m);
    expect(help.stdout).toContain("`portifact licenses` prints the notices");
    expect(help.stdout).toContain("AGPL-3.0");

    const result = await invoke("licenses");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Third-party notices for the Portifact CLI");
    // The CLI's runtime dependencies and the runtime the binary embeds.
    for (const name of ["commander (MIT)", "zod (MIT)", "Bun runtime"]) {
      expect(result.stdout).toContain(name);
    }
    expect(result.stdout).toContain("Permission is hereby granted");
  });

  it("documents publishing options, ZIP input, private sources and assets", async () => {
    const result = await invoke("publish", "--help");
    expect(result.code).toBe(0);
    for (const flag of ["--type", "--name", "--entry", "--artifact", "--dry-run", "--json"]) {
      expect(result.stdout).toContain(flag);
    }
    expect(result.stdout).toContain("--source <path>");
    expect(result.stdout).toContain("--ref <commit>");
    expect(result.stdout).toContain("--assets <dir>");
    expect(result.stdout).toContain("A ZIP file is expanded");
    expect(result.stdout).toContain("node_modules");
  });

  it("documents the access subcommands and the delete confirmation flag", async () => {
    const access = await invoke("access", "--help");
    for (const sub of ["set", "bar", "add", "remove"]) {
      expect(access.stdout).toMatch(new RegExp(`^  ${sub} `, "m"));
    }
    expect((await invoke("delete", "--help")).stdout).toContain("-y, --yes");
  });

  it("lists tokens in the help and documents its subcommands and the revoke flag", async () => {
    expect((await invoke("--help")).stdout).toMatch(/^ {2}tokens /m);
    const tokens = await invoke("tokens", "--help");
    for (const sub of ["list", "revoke"]) {
      expect(tokens.stdout).toMatch(new RegExp(`^  ${sub} `, "m"));
    }
    expect(tokens.stdout).toContain("signs this device out too");
    expect((await invoke("tokens", "revoke", "--help")).stdout).toContain("-y, --yes");
    expect((await invoke("tokens", "revoke")).code).toBe(2);
  });

  it("fails with the usage exit code when an argument is missing", async () => {
    for (const argv of [["publish"], ["info"], ["access", "set", "abcdefghij"]]) {
      const result = await invoke(...argv);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("missing required argument");
    }
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
    expect(notice).toContain("portifact publish <path>");
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
