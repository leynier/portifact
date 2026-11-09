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
  return [...workflow.matchAll(/^\s+- project: (\S+)$/gm)].map((match) => match[1] as string);
}

describe("the e2e matrix in ci.yml", () => {
  it("has exactly one job per Playwright project", () => {
    const projects = playwrightProjects(read("e2e/playwright.config.ts"));
    expect(projects.length).toBeGreaterThan(0);
    expect(matrixProjects(read(".github/workflows/ci.yml")).sort()).toEqual([...projects].sort());
  });
});
