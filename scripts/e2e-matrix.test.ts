import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CI runs the end-to-end suite as one job per Playwright project (docs/releasing.md); a project
// missing from the matrix would silently never run in CI.
const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

function playwrightProjects(config: string): string[] {
  const block = config.slice(config.indexOf("projects: ["));
  return [...block.matchAll(/^\s{6}name: "([^"]+)"/gm)].map((match) => match[1] as string);
}

function matrixProjects(workflow: string): string[] {
  const list = workflow.match(/^\s+project: \[([^\]]+)\]$/m)?.[1] ?? "";
  return list
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function browserEntries(workflow: string): string[] {
  return [...workflow.matchAll(/^\s+- project: (\S+)\n\s+browser: \S+$/gm)].map(
    (match) => match[1] as string,
  );
}

describe("the e2e matrix in ci.yml", () => {
  it("has exactly one job per Playwright project", () => {
    const projects = playwrightProjects(read("e2e/playwright.config.ts"));
    expect(projects.length).toBeGreaterThan(0);
    const workflow = read(".github/workflows/ci.yml");
    expect(matrixProjects(workflow).sort()).toEqual([...projects].sort());
    // Every project needs its browser, or the job installs none and the run fails late.
    expect(browserEntries(workflow).sort()).toEqual([...projects].sort());
  });

  it("splits every project into the shards it runs", () => {
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toMatch(/^\s+shard: \[1, 2\]$/m);
    expect(workflow).toContain(
      "bun run test:e2e -- --project=${{ matrix.project }} --shard=${{ matrix.shard }}/2",
    );
  });
});

describe("the artifact data grant experiment in the e2e jobs", () => {
  it("has the same Playwright projects as the e2e suite, so each job's --project exists", () => {
    const projects = playwrightProjects(read("e2e/playwright.config.ts"));
    expect(
      playwrightProjects(read("spikes/artifact-data-grant/playwright.config.ts")).sort(),
    ).toEqual([...projects].sort());
    expect(read(".github/workflows/ci.yml")).toContain(
      "bun run --cwd spikes/artifact-data-grant spike -- --project=${{ matrix.project }}",
    );
  });
});
