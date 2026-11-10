// Third-party notices for what Portifact ships: the Workers, the web bundle and the CLI binary.
// Pure logic with the file system injected, so it is unit tested; scripts/third-party-notices.ts
// runs it on the installed packages.
import { dirname, join, relative, sep } from "node:path";

/** What the collector reads from disk; the script passes the real file system. */
export interface PackageFs {
  /** The text of a file, or undefined when it does not exist. */
  read(path: string): string | undefined;
  /** The entries of a directory, or [] when it does not exist. */
  list(path: string): string[];
  /** The real path of an existing directory, or undefined. */
  realpath(path: string): string | undefined;
}

/** A shipped component and the workspace packages its build bundles. */
export interface Component {
  id: string;
  title: string;
  roots: string[];
  /**
   * Build tools that put some of their own code in the output (Tailwind's base styles), listed
   * without following their dependencies, which stay on the build machine.
   */
  extras?: string[];
}

export interface CollectedPackage {
  name: string;
  license: string;
  repository: string | null;
  author: string | null;
  /** The installed versions, sorted, so a reviewed exception can name the exact one. */
  versions: string[];
  /** Distinct license and notice texts across installed versions, in file name order. */
  texts: { file: string; text: string }[];
  components: string[];
}

interface Manifest {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
  repository?: unknown;
  author?: unknown;
  dependencies?: Record<string, string>;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.\-_].*)?$/i;

/** Finds a dependency the way Node resolves it: in `node_modules` of each ancestor directory. */
export function resolvePackage(fs: PackageFs, fromDir: string, name: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    const candidate = fs.realpath(join(dir, "node_modules", name));
    if (candidate && fs.read(join(candidate, "package.json")) !== undefined) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function manifest(fs: PackageFs, dir: string): Manifest {
  const text = fs.read(join(dir, "package.json"));
  if (text === undefined) throw new Error(`no package.json in ${dir}`);
  return JSON.parse(text) as Manifest;
}

/**
 * Licenses of packages whose manifest declares none, read from their license file by hand. Keyed
 * by exact version, so an update is reviewed again; adding one is a license review.
 */
export const REVIEWED_LICENSES: Record<string, string> = {
  // A Mermaid dependency: its `license` file is the MIT License.
  "khroma@2.1.0": "MIT",
};

/** The SPDX expression a manifest declares (or a reviewed one when it declares none), or UNKNOWN. */
export function declaredLicense(m: Manifest): string {
  const value = m.license ?? m.licenses;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const type = (value as { type?: unknown }).type;
    if (typeof type === "string") return type;
  }
  if (Array.isArray(value)) {
    const types = value
      .map((entry) =>
        entry && typeof entry === "object" ? (entry as { type?: unknown }).type : entry,
      )
      .filter((type): type is string => typeof type === "string");
    if (types.length > 0)
      return types.length === 1 ? (types[0] as string) : `(${types.join(" OR ")})`;
  }
  return REVIEWED_LICENSES[`${m.name}@${m.version}`] ?? "UNKNOWN";
}

/** A browsable source URL from the manifest's repository field. */
export function repositoryUrl(m: Manifest): string | null {
  const value = m.repository;
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? (value as { url?: unknown }).url
        : undefined;
  if (typeof raw !== "string" || raw === "") return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  const shorthand = /^(github|gitlab|bitbucket):(.+)$/.exec(raw);
  if (shorthand)
    return `https://${shorthand[1]}.${shorthand[1] === "bitbucket" ? "org" : "com"}/${shorthand[2]}`;
  return raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "");
}

function authorOf(m: Manifest): string | null {
  const value = m.author;
  if (typeof value === "string") return value.replace(/\s*[<(].*$/, "").trim() || null;
  if (value && typeof value === "object") {
    const name = (value as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  }
  return null;
}

function isWorkspace(repoRoot: string, dir: string): boolean {
  const rel = relative(repoRoot, dir);
  return !rel.startsWith("..") && !rel.split(sep).includes("node_modules");
}

/**
 * Walks the production dependencies of every component: workspace packages are followed but
 * not listed (they are Portifact's own code), third-party packages are listed with their license
 * texts and followed too. Dev and optional dependencies are not shipped, so they are skipped.
 */
export function collectPackages(
  fs: PackageFs,
  repoRoot: string,
  components: readonly Component[],
): CollectedPackage[] {
  const byName = new Map<string, CollectedPackage>();
  for (const component of components) {
    const seen = new Set<string>();
    const visit = (dir: string, deps: readonly string[], follow = true) => {
      for (const name of deps) {
        const resolved = resolvePackage(fs, dir, name);
        if (!resolved) throw new Error(`${name} is not installed (needed from ${dir})`);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        const m = manifest(fs, resolved);
        if (!isWorkspace(repoRoot, resolved)) record(resolved, m);
        if (follow) visit(resolved, Object.keys(m.dependencies ?? {}));
      }
    };
    const record = (dir: string, m: Manifest) => {
      const name = m.name ?? dir;
      const entry =
        byName.get(name) ??
        ({
          name,
          license: declaredLicense(m),
          repository: repositoryUrl(m),
          author: authorOf(m),
          versions: [],
          texts: [],
          components: [],
        } satisfies CollectedPackage);
      byName.set(name, entry);
      if (!entry.components.includes(component.id)) entry.components.push(component.id);
      if (m.version && !entry.versions.includes(m.version)) entry.versions.push(m.version);
      const files = fs
        .list(dir)
        .filter((file) => LICENSE_FILE.test(file))
        .sort();
      for (const file of files) {
        const text = normalizeText(fs.read(join(dir, file)) ?? "");
        if (text !== "" && !entry.texts.some((t) => t.text === text))
          entry.texts.push({ file, text });
      }
    };
    for (const root of component.roots) {
      const dir = join(repoRoot, root);
      visit(dir, Object.keys(manifest(fs, dir).dependencies ?? {}));
    }
    // Only the extra package's own output ships, not the build tool's dependencies.
    if (component.extras?.length) {
      visit(join(repoRoot, component.roots[0] ?? ""), component.extras, false);
    }
  }
  const order = components.map((c) => c.id);
  return [...byName.values()]
    .map((p) => ({
      ...p,
      components: [...p.components].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
      versions: [...p.versions].sort(),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

/**
 * Licenses whose code can be combined into and distributed with an AGPL-3.0 program: permissive
 * licenses, weak copyleft that allows it (MPL-2.0 section 3.3, LGPL) and the GPL-3.0 family.
 * Adding an identifier here is a license review: say why in the change.
 */
export const AGPL_COMPATIBLE = new Set([
  "0BSD",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "CC-BY-4.0",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "ISC",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  // The Python Software Foundation License, which the FSF lists as GPL-compatible.
  "PSF-2.0",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);

/**
 * Licenses that also let the maintainer ship Portifact under a commercial license without the
 * AGPL's obligations (docs/licensing.md): permissive licenses only, which ask for notices and
 * nothing about the rest of the program. Strong copyleft (GPL, AGPL) is never here. Weak
 * copyleft is left out on purpose too: LGPL-2.1 and LGPL-3.0 ask that users can relink a
 * modified library, MPL-2.0 and EPL-2.0 keep their files under their own terms with source
 * available. Each can be compatible with a commercial license, but only after a review of how
 * that package is shipped, so it goes in COMMERCIAL_EXCEPTIONS for an exact version instead.
 * Adding an identifier here is a license review: say why in the change.
 */
export const COMMERCIAL_COMPATIBLE = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "CC-BY-4.0",
  "ISC",
  "MIT",
  "MIT-0",
  // The Python Software Foundation License: permissive, with a notice requirement.
  "PSF-2.0",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);

/**
 * Shipped packages whose license is AGPL compatible but not in COMMERCIAL_COMPATIBLE, accepted
 * for the commercial license for an exact version with the reason. An update of the package
 * needs the review again. Every entry is pending a lawyer's review (docs/licensing.md).
 */
export const COMMERCIAL_EXCEPTIONS: Record<string, string> = {
  // Mermaid's ELK layout engine, bundled unmodified in the diagram script that the content
  // Worker serves to browsers. EPL-2.0 is weak copyleft at the file level: section 3.2 allows
  // distributing the object code under other terms when its source is offered, which the
  // notices do by linking the package's repository. It never covers the rest of Portifact.
  "elkjs@0.12.1": "EPL-2.0, weak copyleft per file, shipped unmodified with its source linked",
};

/** Splits an SPDX expression into its OR groups of AND-ed identifiers (the common forms). */
function licenseGroups(expression: string): string[][] {
  const tokens = expression.replace(/[()]/g, " ").trim().split(/\s+/);
  const groups: string[][] = [[]];
  for (const token of tokens) {
    if (token === "OR") groups.push([]);
    else if (token !== "AND") (groups.at(-1) as string[]).push(token);
  }
  return groups;
}

/** Whether one side of an OR has every identifier in the allowed set. */
function satisfies(expression: string, allowed: ReadonlySet<string>): boolean {
  return licenseGroups(expression).some(
    (group) => group.length > 0 && group.every((id) => allowed.has(id.replace(/\+$/, ""))),
  );
}

/**
 * Whether an SPDX expression can be used under AGPL-3.0: an OR needs one compatible side, an AND
 * needs both. Unknown identifiers are not compatible, so a new license is reviewed by hand.
 */
export function agplCompatible(expression: string): boolean {
  return satisfies(expression, AGPL_COMPATIBLE);
}

/** Whether an SPDX expression also allows shipping Portifact under a commercial license. */
export function commercialCompatible(expression: string): boolean {
  return satisfies(expression, COMMERCIAL_COMPATIBLE);
}

/** Whether every installed version of a package has a reviewed commercial exception. */
function commercialException(
  p: CollectedPackage,
  exceptions: Readonly<Record<string, string>>,
): boolean {
  return p.versions.length > 0 && p.versions.every((v) => `${p.name}@${v}` in exceptions);
}

/** Packages whose license is not compatible or not known, for the check to refuse. */
export function licenseProblems(
  packages: readonly CollectedPackage[],
  exceptions: Readonly<Record<string, string>> = COMMERCIAL_EXCEPTIONS,
): string[] {
  const problems: string[] = [];
  for (const p of packages) {
    if (!agplCompatible(p.license)) {
      problems.push(
        `${p.name}: license "${p.license}" is not known to be compatible with AGPL-3.0`,
      );
    } else if (!commercialCompatible(p.license) && !commercialException(p, exceptions)) {
      problems.push(
        `${p.name}@${p.versions.join(", ")}: license "${p.license}" is not permissive, so Portifact could not be shipped under a commercial license with it (see docs/licensing.md)`,
      );
    }
  }
  return problems;
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longest + 1);
}

export interface RenderOptions {
  components: readonly Component[];
  /** Extra notices that are not npm packages, such as the runtime the CLI binary embeds. */
  runtimeNotices: readonly { component: string; text: string }[];
}

/** The full notices document in Markdown, deterministic for the same packages. */
export function renderMarkdown(
  packages: readonly CollectedPackage[],
  options: RenderOptions,
): string {
  const titles = new Map(options.components.map((c) => [c.id, c.title]));
  const lines = [
    "# Third-party notices",
    "",
    "Portifact is licensed under the GNU Affero General Public License v3.0 only (see `license`). It ships open source software by others in its Cloudflare Workers, its web pages and its CLI binary. This file lists each of those packages with its license and the license and copyright notices it includes. It is generated by `bun run notices` from the installed packages; do not edit it by hand.",
    "",
  ];
  for (const notice of options.runtimeNotices) lines.push(notice.text, "");
  lines.push("## Summary", "", "| Package | License | Shipped in |", "| --- | --- | --- |");
  for (const p of packages) {
    const shipped = p.components.map((id) => titles.get(id) ?? id).join(", ");
    lines.push(`| ${p.name} | ${p.license} | ${shipped} |`);
  }
  lines.push("", "## Licenses and notices", "");
  for (const p of packages) {
    lines.push(`### ${p.name}`, "");
    lines.push(`- License: ${p.license}`);
    if (p.repository) lines.push(`- Source: ${p.repository}`);
    lines.push("");
    if (p.texts.length === 0) {
      const by = p.author ? ` Copyright holder: ${p.author}.` : "";
      lines.push(
        `The package includes no license file. It is distributed under ${p.license}; the license text is at https://spdx.org/licenses/.${by}`,
        "",
      );
    }
    for (const { file, text } of p.texts) {
      const marks = fence(text);
      lines.push(`${file}:`, "", `${marks}text`, text, marks, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The notices of one component as plain text, for the CLI to print. */
export function renderPlainText(
  packages: readonly CollectedPackage[],
  component: string,
  runtimeNotices: RenderOptions["runtimeNotices"],
): string {
  const parts = [
    "Third-party notices for the Portifact CLI",
    "",
    "Portifact is licensed under AGPL-3.0-only; its source is at https://github.com/leynier/portifact. The CLI binary includes the following open source software.",
  ];
  for (const notice of runtimeNotices.filter((n) => n.component === component)) {
    parts.push("", notice.text);
  }
  for (const p of packages.filter((pkg) => pkg.components.includes(component))) {
    parts.push("", "=".repeat(72), `${p.name} (${p.license})`);
    if (p.repository) parts.push(p.repository);
    if (p.texts.length === 0) {
      parts.push(
        "",
        `No license file included. License: ${p.license}.${p.author ? ` Copyright holder: ${p.author}.` : ""}`,
      );
    }
    for (const { text } of p.texts) parts.push("", text);
  }
  return `${parts.join("\n")}\n`;
}

/** The generated TypeScript module the CLI imports. */
export function renderCliModule(text: string): string {
  return [
    "// Generated by `bun run notices` from the installed packages; do not edit by hand.",
    "// The third-party notices of what the CLI binary includes, printed by `portifact licenses`.",
    // Biome's layout for a string longer than a line, so `bun run check` accepts the file as is.
    "export const THIRD_PARTY_NOTICES =",
    `  ${JSON.stringify(text)};`,
    "",
  ].join("\n");
}
