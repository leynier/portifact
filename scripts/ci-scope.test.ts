import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  changedFiles,
  cliWorkspaceDeps,
  FULL_SCOPE,
  formatOutput,
  type RunIo,
  run,
  scopeOf,
} from "./ci-scope.ts";

describe("CI scope", () => {
  it("skips the CLI build and smoke tests when only the app and the landing change", () => {
    expect(
      scopeOf([
        "apps/app/src/auth/auth.ts",
        "apps/web/index.html",
        "packages/services/src/publish.ts",
      ]),
    ).toEqual({ quality: true, cli: false });
  });

  it("runs the CLI jobs for the CLI, its build and installer scripts", () => {
    for (const file of [
      "packages/cli/src/main.ts",
      "packages/cli/package.json",
      "scripts/build-cli.ts",
      "scripts/set-version.ts",
      "scripts/install.sh",
      "scripts/install.ps1",
      "scripts/smoke-linux-distros.sh",
    ]) {
      expect(scopeOf([file]).cli, file).toBe(true);
    }
  });

  it("runs everything when shared tooling, dependencies or the workflows change", () => {
    for (const file of [
      "package.json",
      "bun.lock",
      "bunfig.toml",
      "tsconfig.base.json",
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
    ]) {
      expect(scopeOf([file]), file).toEqual(FULL_SCOPE);
    }
  });

  it("runs the CLI jobs when a workspace package the CLI depends on changes", () => {
    expect(scopeOf(["packages/contracts/src/index.ts"]).cli).toBe(false);
    expect(scopeOf(["packages/contracts/src/index.ts"], ["contracts"]).cli).toBe(true);
    expect(scopeOf(["packages/contracts-extra/x.ts"], ["contracts"]).cli).toBe(false);
  });

  it("reads the CLI's workspace dependencies from its package.json", () => {
    const manifest = JSON.stringify({
      dependencies: { commander: "^15.0.0", "@portifact/contracts": "workspace:*" },
      devDependencies: { "@portifact/domain": "workspace:*", vitest: "catalog:" },
    });
    expect(cliWorkspaceDeps(manifest)).toEqual(["contracts", "domain"]);
    expect(cliWorkspaceDeps("{}")).toEqual([]);
  });

  it("skips everything but required bookkeeping for documentation-only changes", () => {
    expect(scopeOf(["docs/security.md", "docs/decisions/0003-x.md", "license"])).toEqual({
      quality: false,
      cli: false,
    });
  });

  it("still checks files that tests or checks read, like the readme and skills", () => {
    expect(scopeOf(["readme.md"]).quality).toBe(true);
    expect(scopeOf(["skills/portifact/SKILL.md"]).quality).toBe(true);
    expect(scopeOf(["AGENTS.md"]).quality).toBe(true);
  });

  it("runs everything when there is no diff to judge", () => {
    expect(scopeOf([])).toEqual(FULL_SCOPE);
    expect(changedFiles("", "HEAD")).toBeUndefined();
    expect(changedFiles("0000000000000000000000000000000000000000", "HEAD")).toBeUndefined();
    expect(changedFiles("not-a-commit", "HEAD")).toBeUndefined();
  });

  it("lists the files changed between two commits", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(changedFiles(head, head)).toEqual([]);
    const parent = execFileSync("git", ["rev-parse", "HEAD~1"], { encoding: "utf8" }).trim();
    const files = changedFiles(parent, head);
    expect(Array.isArray(files)).toBe(true);
    expect(files?.length).toBeGreaterThan(0);
  });

  it("writes GitHub Actions outputs", () => {
    expect(formatOutput({ quality: true, cli: false })).toBe("quality=true\ncli=false\n");
  });

  it("runs from the command line, logging and writing the outputs", () => {
    const logged: string[] = [];
    const written: string[] = [];
    const io: RunIo = {
      readCliManifest: () => JSON.stringify({ dependencies: { commander: "^15.0.0" } }),
      log: (line) => logged.push(line),
      writeOutput: (text) => written.push(text),
    };
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(run([head, head], io)).toEqual(FULL_SCOPE);
    expect(logged[0]).toBe("0 changed file(s)");
    expect(run([head, head, "full"], io)).toEqual(FULL_SCOPE);
    expect(logged).toContain("running everything");
    expect(run([], { ...io, writeOutput: undefined })).toEqual(FULL_SCOPE);
    expect(written).toEqual([formatOutput(FULL_SCOPE), formatOutput(FULL_SCOPE)]);
  });
});
