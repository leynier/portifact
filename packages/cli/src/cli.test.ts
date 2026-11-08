import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { notice, run, version } from "./cli.ts";

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
    expect(result.stderr).toBe("");
  });

  it("explains the development status when run without arguments", async () => {
    const result = await invoke();

    expect(result).toEqual({ code: 0, stdout: notice, stderr: "" });
    expect(notice).toContain("early development");
  });

  it("fails with a non-zero exit code and an error on unknown options", async () => {
    const result = await invoke("--does-not-exist");

    expect(result.code).toBe(1);
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
