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
 * Validates every path of a version's manifest. Rejects invalid paths, `.git` segments, duplicates after
 * normalization, names that differ only by case (they collide on case-insensitive file
 * systems when the artifact is downloaded), a file that is also used as a directory, and more
 * files than a version may hold.
 */
export function validateManifestPaths(rawPaths: readonly string[]): Result<string[]> {
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
    const key = result.value.toLowerCase();
    if (seen.has(key)) return fail("invalid_input", `${raw}: collides with another file.`);
    seen.add(key);
    paths.push(result.value);
  }
  for (const path of paths) {
    const segments = path.toLowerCase().split("/");
    for (let i = 1; i < segments.length; i++) {
      if (seen.has(segments.slice(0, i).join("/"))) {
        return fail("invalid_input", `${path}: a parent of this file is also a file.`);
      }
    }
  }
  return ok(paths);
}
