import { LIMITS } from "@portifact/contracts";
import { fail, ok, type Result } from "./result.ts";

/** First path segment reserved for platform routes on artifact origins. */
export const RESERVED_SEGMENT = "__portifact";
const MAX_SEGMENT_LENGTH = 255;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Normalizes a path inside an artifact (as uploaded or requested) to its canonical form, or
 * rejects it. Canonical paths are relative, use `/`, have no empty, `.` or `..` segments, are
 * NFC-normalized, and never start with the reserved `__portifact` segment. The server applies
 * this to every manifest entry, whatever the client already did (see docs/security.md, "Uploads").
 */
export function normalizePath(raw: string): Result<string> {
  if (CONTROL_CHARACTERS.test(raw))
    return fail("invalid_input", "Path contains control characters.");
  if (raw.includes("\\")) return fail("invalid_input", "Path must use forward slashes.");
  if (raw.startsWith("/")) return fail("invalid_input", "Path must be relative.");
  if (/^[a-zA-Z]:/.test(raw)) return fail("invalid_input", "Path must not include a drive letter.");

  const segments: string[] = [];
  for (const segment of raw.normalize("NFC").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return fail("invalid_input", "Path must not contain `..` segments.");
    if (segment.length > MAX_SEGMENT_LENGTH)
      return fail("invalid_input", "Path segment is too long.");
    segments.push(segment);
  }

  if (segments.length === 0) return fail("invalid_input", "Path is empty.");
  if (segments[0]?.toLowerCase() === RESERVED_SEGMENT) {
    return fail("invalid_input", `Paths under /${RESERVED_SEGMENT}/ are reserved.`);
  }
  const path = segments.join("/");
  if (path.length > LIMITS.pathMaxLength) return fail("invalid_input", "Path is too long.");
  return ok(path);
}

/**
 * Whether a path segment names a Git directory: `.git` in any case, also as Windows resolves it
 * (trailing dots and spaces dropped, or the 8.3 short name `git~1`). Manifests and downloads
 * refuse these, so materializing an artifact's files can never install hooks or configuration.
 */
export function isGitSegment(segment: string): boolean {
  const name = segment.toLowerCase().replace(/[. ]+$/, "");
  return name === ".git" || name === "git~1";
}

/**
 * Validates every path of a version's manifest at publish. Rejects invalid paths, `.git`
 * segments, duplicates after normalization, names that differ only by case
 * (`publishCollisionKey`), a file that is also used as a directory, and more files than a version
 * may hold. What it accepts must not change without a product decision: artifacts already hold
 * what it accepted, and updating them must keep working. Downloads check the stricter
 * `validateDownloadPaths` instead.
 */
export function validateManifestPaths(rawPaths: readonly string[]): Result<string[]> {
  return checkPaths(rawPaths, publishCollisionKey);
}

/**
 * Validates a version's paths before they are written to the reader's disk (`pull`,
 * `export`): the publish rules, with the stricter `downloadCollisionKey`, because there the
 * reader's file system decides which names are one file. Refused, nothing is written; the
 * publish side keeps accepting what it always did.
 */
export function validateDownloadPaths(rawPaths: readonly string[]): Result<string[]> {
  return checkPaths(rawPaths, downloadCollisionKey);
}

function checkPaths(rawPaths: readonly string[], key: (path: string) => string): Result<string[]> {
  if (rawPaths.length > LIMITS.filesPerVersion) {
    return fail("quota_exceeded", `A version can hold at most ${LIMITS.filesPerVersion} files.`);
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawPaths) {
    const result = normalizePath(raw);
    if (!result.ok) return fail(result.code, `${raw}: ${result.message}`);
    if (result.value.split("/").some(isGitSegment)) {
      return fail("invalid_input", `${raw}: paths inside a .git folder are not allowed.`);
    }
    const folded = key(result.value);
    if (seen.has(folded)) return fail("invalid_input", `${raw}: collides with another file.`);
    seen.add(folded);
    paths.push(result.value);
  }
  for (const path of paths) {
    const segments = key(path).split("/");
    for (let i = 1; i < segments.length; i++) {
      if (seen.has(segments.slice(0, i).join("/"))) {
        return fail("invalid_input", `${path}: a parent of this file is also a file.`);
      }
    }
  }
  return ok(paths);
}

/**
 * The publish side's collision key: lower case of the canonical (NFC) path, exactly what manifests
 * have always been checked with. Do not make it stricter: artifacts already hold pairs only the
 * download key refuses, and their updates must keep publishing. Never merge it with
 * `downloadCollisionKey`.
 */
export function publishCollisionKey(path: string): string {
  return path.toLowerCase();
}

/**
 * The download side's collision key: what two paths share when a case-insensitive or normalizing
 * file system would store them as one file, the canonical composition of their case-folded form
 * (case through upper then lower on the decomposed form, so `ſ`, `K` and `ß` meet `s`, `k` and
 * `ss` as Windows and macOS fold them). Only `validateDownloadPaths` uses it, before anything is
 * written to the reader's disk. Never merge it with `publishCollisionKey`.
 */
export function downloadCollisionKey(path: string): string {
  return path.normalize("NFD").toUpperCase().toLowerCase().normalize("NFC");
}

/**
 * Names Windows treats as devices whatever their extension and trailing spaces (`con.txt`,
 * `CON .txt`, `com0`, `conin$`).
 */
const WINDOWS_DEVICE =
  /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$) *(\..*)?$/i;
const WINDOWS_FORBIDDEN = /[<>:"|?*]/;

/**
 * Why Windows cannot store a path segment under that name, or null when it can: a device name,
 * a character Windows forbids in names, or a trailing dot or space (which Windows drops, so the
 * file would land under another name). The one rule `pull` and `export` apply on Windows.
 */
export function windowsNameProblem(segment: string): string | null {
  if (WINDOWS_DEVICE.test(segment)) return "The path names a Windows device.";
  if (WINDOWS_FORBIDDEN.test(segment) || /[. ]$/.test(segment)) {
    return "The path holds a name Windows cannot store.";
  }
  return null;
}
