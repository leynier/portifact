import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// quality.yml runs `turbo run test` as parallel groups. A package no group runs would silently
// never be tested in CI, so the `rest` group must exclude exactly what the other groups name.
const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

interface Group {
  group: string;
  filters: string[];
}

function groups(workflow: string): Group[] {
  return [...workflow.matchAll(/^\s+- group: (\S+)\n\s+filter: (.+)$/gm)].map((match) => ({
    group: match[1] as string,
    filters: (match[2] as string).trim().split(/\s+/),
  }));
}

function workspacePackages(): string[] {
  return ["apps", "packages", "spikes"].flatMap((dir) =>
    readdirSync(new URL(`${dir}/`, root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        try {
          return [JSON.parse(read(`${dir}/${entry.name}/package.json`)).name as string];
        } catch {
          return [];
        }
      }),
  );
}

describe("the test groups in quality.yml", () => {
  const all = groups(read(".github/workflows/quality.yml"));
  const named = all.filter((g) => g.group !== "rest");
  const rest = all.find((g) => g.group === "rest");

  it("has named groups and a rest group", () => {
    expect(named.length).toBeGreaterThan(0);
    expect(rest).toBeDefined();
  });

  it("names only existing packages, each in one group", () => {
    const packages = new Set(workspacePackages());
    const included = named.flatMap((g) => g.filters);
    for (const filter of included) {
      expect(filter).toMatch(/^--filter=@portifact\/[a-z0-9-]+$/);
      expect(packages.has(filter.slice("--filter=".length)), filter).toBe(true);
    }
    expect(new Set(included).size).toBe(included.length);
  });

  it("excludes from rest exactly the packages the named groups run", () => {
    const included = named.flatMap((g) => g.filters.map((f) => f.slice("--filter=".length)));
    const excluded = (rest?.filters ?? []).map((f) => {
      expect(f).toMatch(/^--filter=!@portifact\/[a-z0-9-]+$/);
      return f.slice("--filter=!".length);
    });
    expect(excluded.sort()).toEqual(included.sort());
  });

  it("is what ci.yml and release.yml run", () => {
    for (const workflow of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
      expect(read(workflow), workflow).toContain("uses: ./.github/workflows/quality.yml");
    }
    expect(read(".github/workflows/release.yml")).toContain("needs: suite");
  });
});
