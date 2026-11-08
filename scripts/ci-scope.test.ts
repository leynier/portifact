import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    ).toEqual({ quality: true, cli: false, e2e: true });
  });

  it("runs the end-to-end suite for the Workers, the dashboard, their packages and the suite", () => {
    for (const file of [
      "apps/app/src/api/review.ts",
      "apps/content/src/review.ts",
      "apps/web/src/dashboard/screens/review.tsx",
      "packages/bridge/src/bridge.ts",
      "packages/services/src/review-access.ts",
      "packages/db/migrations/0012_review_tab.sql",
      "e2e/tests/review.spec.ts",
      "e2e/playwright.config.ts",
      "turbo.json",
      "bun.lock",
      ".github/workflows/ci.yml",
    ]) {
      expect(scopeOf([file]).e2e, file).toBe(true);
    }
  });

  it("skips the end-to-end suite for the CLI, the jobs Worker, scripts and skills", () => {
    for (const file of [
      "packages/cli/src/main.ts",
      "apps/jobs/src/index.ts",
      "scripts/install.sh",
      "skills/portifact/SKILL.md",
      "spikes/review-cookies/src/server.ts",
      ".github/workflows/release.yml",
      "packages/readme.md",
    ]) {
      expect(scopeOf([file]).e2e, file).toBe(false);
    }
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
    ]) {
      expect(scopeOf([file]), file).toEqual(FULL_SCOPE);
    }
    expect(scopeOf([".github/workflows/release.yml"])).toEqual({
      quality: true,
      cli: true,
      e2e: false,
    });
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
      e2e: false,
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
    // A throwaway repository, so the test does not depend on the checkout's history depth.
    const repo = mkdtempSync(join(tmpdir(), "ci-scope-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
    try {
      git("init", "-q");
      writeFileSync(join(repo, "a.txt"), "a");
      git("add", ".");
      git("commit", "-qm", "first");
      const first = git("rev-parse", "HEAD");
      mkdirSync(join(repo, "packages", "cli"), { recursive: true });
      writeFileSync(join(repo, "packages", "cli", "main.ts"), "b");
      git("add", ".");
      git("commit", "-qm", "second");
      const second = git("rev-parse", "HEAD");
      expect(changedFiles(first, second, repo)).toEqual(["packages/cli/main.ts"]);
      expect(changedFiles(second, second, repo)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("writes GitHub Actions outputs", () => {
    expect(formatOutput({ quality: true, cli: false, e2e: true })).toBe(
      "quality=true\ncli=false\ne2e=true\n",
    );
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
