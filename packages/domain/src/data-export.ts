// Where `portifact export` writes each file (decision 0022, second delivery), and which artifact
// paths it refuses to write. Pure: the CLI resolves the result under the export folder and checks
// once more that it stays inside it. The rules are `pull`'s (canonical, no `..`, relative, no
// `.git` segment) plus, on Windows, no device name and no character Windows forbids in a name.
import type { DownloadKind } from "@portifact/contracts";
import { isGitSegment, normalizePath, windowsNameProblem } from "./paths.ts";
import { fail, ok, type Result } from "./result.ts";

/** The folder of one version's files of a kind, relative to the export folder. */
export function exportVersionFolder(
  artifactId: string,
  versionNumber: number,
  kind: DownloadKind,
): string {
  return `artifacts/${artifactId}/v${versionNumber}/${kind}`;
}

/**
 * Whether an artifact's file path may be written by an export: it must already be canonical (the
 * server's own rules, so nothing is rewritten silently), free of `.git` segments and, when the
 * export runs on Windows, of device names, trailing dots or spaces and forbidden characters.
 * The answer is the path's segments, ready to join under the version's folder.
 */
export function exportPathSegments(path: string, windows: boolean): Result<string[]> {
  const canonical = normalizePath(path);
  if (!canonical.ok) return canonical;
  if (canonical.value !== path) return fail("invalid_input", "The path is not canonical.");
  const segments = path.split("/");
  if (segments.some(isGitSegment)) {
    return fail("invalid_input", "Paths inside a .git folder are not written.");
  }
  if (windows) {
    for (const segment of segments) {
      const problem = windowsNameProblem(segment);
      if (problem) return fail("invalid_input", problem);
    }
  }
  return ok(segments);
}
