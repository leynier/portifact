import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agplCompatible,
  type CollectedPackage,
  type Component,
  collectPackages,
  declaredLicense,
  licenseProblems,
  type PackageFs,
  renderCliModule,
  renderMarkdown,
  renderPlainText,
  repositoryUrl,
  resolvePackage,
} from "./notices.ts";

/** An in-memory tree: paths to file contents; directories are implied, symlinks map to targets. */
function fakeFs(files: Record<string, string>, links: Record<string, string> = {}): PackageFs {
  const resolve = (path: string): string => {
    for (const [link, target] of Object.entries(links)) {
      if (path === link || path.startsWith(`${link}/`))
        return resolve(target + path.slice(link.length));
    }
    return path;
  };
  const isDir = (path: string) => Object.keys(files).some((file) => file.startsWith(`${path}/`));
  return {
    read: (path) => files[resolve(path)],
    list: (path) => {
      const dir = resolve(path);
      const names = Object.keys(files)
        .filter((file) => file.startsWith(`${dir}/`))
        .map((file) => file.slice(dir.length + 1).split("/")[0] as string);
      return [...new Set(names)];
    },
    realpath: (path) => {
      const real = resolve(path);
      return isDir(real) ? real : undefined;
    },
  };
}

const pkg = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, version: "1.0.0", license: "MIT", ...extra });

const MIT = "MIT License\n\nCopyright (c) 2026 Someone  \r\n\r\nPermission is hereby granted";

// Isolated layout like Bun's: workspace packages link into .bun, whose packages see their
// dependencies as siblings.
const files = {
  "/repo/apps/a/package.json": pkg("@p/a", {
    dependencies: { "@p/shared": "workspace:*", left: "^1.0.0" },
    devDependencies: { devonly: "^1.0.0" },
  }),
  "/repo/apps/cli/package.json": pkg("@p/cli", { dependencies: { left: "^1.0.0" } }),
  "/repo/packages/shared/package.json": pkg("@p/shared", { dependencies: { right: "^2.0.0" } }),
  "/repo/node_modules/.bun/left@1/node_modules/left/package.json": pkg("left", {
    dependencies: { deep: "^1.0.0" },
    optionalDependencies: { optional: "^1.0.0" },
    repository: "git+https://github.com/o/left.git",
  }),
  "/repo/node_modules/.bun/left@1/node_modules/left/LICENSE": MIT,
  "/repo/node_modules/.bun/left@1/node_modules/left/index.js": "",
  "/repo/node_modules/.bun/deep@1/node_modules/deep/package.json": pkg("deep", {
    license: "(MIT OR GPL-2.0-only)",
  }),
  "/repo/node_modules/.bun/deep@1/node_modules/deep/LICENSE.md": "Copyright deep",
  "/repo/node_modules/.bun/deep@1/node_modules/deep/NOTICE": "Copyright deep",
  "/repo/node_modules/.bun/right@2/node_modules/right/package.json": pkg("right", {
    license: undefined,
    licenses: [{ type: "Apache-2.0" }],
    author: { name: "Right Author" },
  }),
  "/repo/node_modules/.bun/tool@3/node_modules/tool/package.json": pkg("tool", {
    dependencies: { hidden: "^1.0.0" },
  }),
};
const links = {
  "/repo/apps/a/node_modules/@p/shared": "/repo/packages/shared",
  "/repo/apps/a/node_modules/left": "/repo/node_modules/.bun/left@1/node_modules/left",
  "/repo/apps/a/node_modules/tool": "/repo/node_modules/.bun/tool@3/node_modules/tool",
  "/repo/apps/cli/node_modules/left": "/repo/node_modules/.bun/left@1/node_modules/left",
  "/repo/packages/shared/node_modules/right": "/repo/node_modules/.bun/right@2/node_modules/right",
  "/repo/node_modules/.bun/left@1/node_modules/deep":
    "/repo/node_modules/.bun/deep@1/node_modules/deep",
};
const COMPONENTS: Component[] = [
  { id: "workers", title: "Workers", roots: ["apps/a"], extras: ["tool"] },
  { id: "cli", title: "CLI", roots: ["apps/cli"] },
];

describe("resolvePackage", () => {
  it("finds a dependency in the nearest node_modules, walking up", () => {
    const fs = fakeFs(files, links);
    expect(resolvePackage(fs, "/repo/apps/a", "left")).toBe(
      "/repo/node_modules/.bun/left@1/node_modules/left",
    );
    expect(resolvePackage(fs, "/repo/node_modules/.bun/left@1/node_modules/left", "deep")).toBe(
      "/repo/node_modules/.bun/deep@1/node_modules/deep",
    );
    expect(resolvePackage(fs, "/repo/apps/a", "missing")).toBeUndefined();
  });
});

describe("collectPackages", () => {
  const collected = collectPackages(fakeFs(files, links), "/repo", COMPONENTS);

  it("lists third-party production dependencies, transitively, sorted by name", () => {
    expect(collected.map((p) => p.name)).toEqual(["deep", "left", "right", "tool"]);
  });

  it("skips workspace packages, dev and optional dependencies and the extras' own dependencies", () => {
    const names = collected.map((p) => p.name);
    for (const name of ["@p/a", "@p/shared", "devonly", "optional", "hidden"]) {
      expect(names).not.toContain(name);
    }
  });

  it("records which components ship each package, in component order", () => {
    const by = Object.fromEntries(collected.map((p) => [p.name, p.components]));
    expect(by).toEqual({
      deep: ["workers", "cli"],
      left: ["workers", "cli"],
      right: ["workers"],
      tool: ["workers"],
    });
  });

  it("keeps each distinct license or notice text once, normalized", () => {
    const left = collected.find((p) => p.name === "left") as CollectedPackage;
    expect(left.texts).toEqual([
      {
        file: "LICENSE",
        text: "MIT License\n\nCopyright (c) 2026 Someone\n\nPermission is hereby granted",
      },
    ]);
    expect(left.repository).toBe("https://github.com/o/left");
    const deep = collected.find((p) => p.name === "deep") as CollectedPackage;
    expect(deep.texts).toEqual([{ file: "LICENSE.md", text: "Copyright deep" }]);
    const right = collected.find((p) => p.name === "right") as CollectedPackage;
    expect(right).toMatchObject({ license: "Apache-2.0", author: "Right Author", texts: [] });
  });

  it("fails when a dependency is not installed", () => {
    const broken = {
      ...files,
      "/repo/apps/cli/package.json": pkg("@p/cli", { dependencies: { nope: "1" } }),
    };
    expect(() => collectPackages(fakeFs(broken, links), "/repo", COMPONENTS)).toThrow(
      "nope is not installed",
    );
  });
});

describe("license metadata", () => {
  it("reads the declared license in its historical forms", () => {
    expect(declaredLicense({ license: " ISC " })).toBe("ISC");
    expect(declaredLicense({ license: { type: "BSD-3-Clause" } })).toBe("BSD-3-Clause");
    expect(declaredLicense({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe(
      "(MIT OR Apache-2.0)",
    );
    expect(declaredLicense({ licenses: ["MIT"] })).toBe("MIT");
    expect(declaredLicense({})).toBe("UNKNOWN");
    expect(declaredLicense({ license: "" })).toBe("UNKNOWN");
  });

  it("turns repository fields into browsable URLs", () => {
    expect(repositoryUrl({ repository: "o/r" })).toBe("https://github.com/o/r");
    expect(repositoryUrl({ repository: "github:o/r" })).toBe("https://github.com/o/r");
    expect(repositoryUrl({ repository: "bitbucket:o/r" })).toBe("https://bitbucket.org/o/r");
    expect(repositoryUrl({ repository: { url: "git+ssh://git@github.com/o/r.git" } })).toBe(
      "https://github.com/o/r",
    );
    expect(repositoryUrl({ repository: "git@gitlab.com:o/r.git" })).toBe("https://gitlab.com/o/r");
    expect(repositoryUrl({ repository: "git://github.com/o/r.git" })).toBe(
      "https://github.com/o/r",
    );
    expect(repositoryUrl({})).toBeNull();
  });
});

describe("AGPL-3.0 compatibility", () => {
  it("accepts permissive, weak copyleft and GPL-3.0 family licenses", () => {
    for (const id of [
      "MIT",
      "Apache-2.0",
      "BSD-3-Clause",
      "ISC",
      "MPL-2.0",
      "PSF-2.0",
      "LGPL-3.0-or-later",
    ]) {
      expect(agplCompatible(id), id).toBe(true);
    }
  });

  it("refuses incompatible and unknown licenses", () => {
    for (const id of [
      "GPL-2.0-only",
      "SSPL-1.0",
      "PolyForm-Shield-1.0.0",
      "UNKNOWN",
      "SEE LICENSE IN x",
      "",
    ]) {
      expect(agplCompatible(id), id).toBe(false);
    }
  });

  it("needs one compatible side of an OR and both sides of an AND", () => {
    expect(agplCompatible("(MIT OR GPL-2.0-only)")).toBe(true);
    expect(agplCompatible("(GPL-2.0-only OR SSPL-1.0)")).toBe(false);
    expect(agplCompatible("MIT AND Apache-2.0")).toBe(true);
    expect(agplCompatible("MIT AND GPL-2.0-only")).toBe(false);
    expect(agplCompatible("(MIT AND BSD-2-Clause) OR SSPL-1.0")).toBe(true);
  });

  it("names every package the check must refuse", () => {
    const base = { repository: null, author: null, texts: [], components: ["cli"] };
    expect(
      licenseProblems([
        { ...base, name: "ok", license: "MIT" },
        { ...base, name: "bad", license: "GPL-2.0-only" },
      ]),
    ).toEqual(['bad: license "GPL-2.0-only" is not known to be compatible with AGPL-3.0']);
  });
});

describe("rendering", () => {
  const collected = collectPackages(fakeFs(files, links), "/repo", COMPONENTS);
  const runtimeNotices = [{ component: "cli", text: "The binary embeds a runtime." }];

  it("writes a deterministic Markdown document with a summary and each package's texts", () => {
    const markdown = renderMarkdown(collected, { components: COMPONENTS, runtimeNotices });
    expect(markdown).toBe(renderMarkdown(collected, { components: COMPONENTS, runtimeNotices }));
    expect(markdown.startsWith("# Third-party notices\n")).toBe(true);
    expect(markdown).toContain("The binary embeds a runtime.");
    expect(markdown).toContain("| left | MIT | Workers, CLI |");
    expect(markdown).toContain("### right\n\n- License: Apache-2.0\n");
    expect(markdown).toContain("The package includes no license file.");
    expect(markdown).toContain("Copyright holder: Right Author.");
    expect(markdown).toContain("LICENSE:\n\n```text\nMIT License");
    expect(markdown.endsWith("https://spdx.org/licenses/.\n")).toBe(true);
    // Headings never end with a period and there are no em dashes (docs/design.md).
    expect(markdown).not.toMatch(/^#.*\.$/m);
    expect(markdown).not.toContain("—");
  });

  it("fences a text with a fence longer than any backtick run in it", () => {
    const tricky = [
      { ...collected[0], texts: [{ file: "LICENSE", text: "a ```` b" }] },
    ] as CollectedPackage[];
    expect(renderMarkdown(tricky, { components: COMPONENTS, runtimeNotices: [] })).toContain(
      "`````text\na ```` b\n`````",
    );
  });

  it("writes the CLI's plain text with only the CLI's packages and runtime", () => {
    const text = renderPlainText(collected, "cli", runtimeNotices);
    expect(text).toContain("The binary embeds a runtime.");
    expect(text).toContain("left (MIT)\nhttps://github.com/o/left");
    expect(text).toContain("deep ((MIT OR GPL-2.0-only))");
    expect(text).not.toContain("\nright (");
    const workers = renderPlainText(collected, "workers", runtimeNotices);
    expect(workers).not.toContain("embeds a runtime");
    expect(workers).toContain(
      "No license file included. License: Apache-2.0. Copyright holder: Right Author.",
    );
  });

  it("embeds the text in a module that round-trips", () => {
    const module = renderCliModule('quote " and\nnewline');
    expect(module).toContain("export const THIRD_PARTY_NOTICES =\n");
    const literal = module.slice(module.indexOf('  "') + 2, module.lastIndexOf(";"));
    expect(JSON.parse(literal)).toBe('quote " and\nnewline');
  });
});

describe("committed notices", () => {
  const root = join(import.meta.dirname, "..");

  it("are current with the installed packages and every license is compatible", () => {
    // The same check `bun run check` runs; it exits non-zero when anything is stale.
    expect(() =>
      execFileSync("bun", ["scripts/third-party-notices.ts", "--check"], {
        cwd: root,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("cover every shipped component", () => {
    const markdown = readFileSync(join(root, "third-party-notices.md"), "utf8");
    for (const row of [
      "| better-auth | MIT | Workers |",
      "| react | MIT | Web pages |",
      "| commander | MIT | CLI |",
    ]) {
      expect(markdown).toContain(row);
    }
  });
});
