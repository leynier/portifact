// Comparing two versions of an artifact (premium plan P3, feature `versionDiff`), for an admin or
// editor of its owner, gated on the owner's plan (a workspace's for a workspace artifact).
//
// The file comparison reads only the two manifests (`version_files`, by SHA-256), never storage.
// The text diff of one file runs here, in the app Worker, rather than in each client: the API,
// the CLI, MCP and the dashboard then share one implementation and one set of bounds, MCP clients
// cannot run code of their own, and the cost is bounded (two R2 reads of at most
// `VERSION_DIFF.fileBytes` each, which is what the dashboard would read through download links,
// plus a diff bounded in lines and changes). It is a read, so neither traffic metering (which
// counts content delivery) nor budget protection applies to it, like `readVersionFile`.
//
// A file is identified by its kind and path, so a rename is one file removed and one added.
import {
  type ComparedFile,
  type DownloadKind,
  type FileChange,
  VERSION_DIFF,
} from "@portifact/contracts";
import type { RegionalDb } from "@portifact/db";
import {
  type DiffHunk,
  decodeUtf8,
  diffText,
  fail,
  normalizePath,
  ok,
  pageHunks,
  type Result,
  requireFeature,
  textDiffEligibility,
  type VersionRetention,
  versionRetention,
} from "@portifact/domain";
import { type SQL, sql } from "drizzle-orm";
import { objectKey } from "./objects.ts";
import {
  type ArtifactRow,
  managedArtifact,
  missingArtifact,
  missingVersion,
  resolveVersion,
  type VersionInfo,
} from "./versions.ts";

export interface ComparedVersion {
  id: string;
  number: number;
}

export interface ComparedEntry {
  kind: DownloadKind;
  path: string;
  change: Exclude<FileChange, "unchanged">;
  before: ComparedFile | null;
  after: ComparedFile | null;
}

export interface ComparisonResult {
  artifactId: string;
  from: ComparedVersion;
  to: ComparedVersion;
  counts: Record<FileChange, number>;
  files: ComparedEntry[];
  nextCursor: string | null;
}

export interface CompareInput {
  userId: string;
  artifactId: string;
  fromVersionId: string;
  toVersionId: string;
  now: number;
}

export type FileDiffBody =
  | { status: "text"; added: number; removed: number; hunks: DiffHunk[]; nextCursor: number | null }
  | {
      status: "identical" | "binary" | "too_large" | "too_many_lines" | "too_many_changes";
    };

export interface FileDiffResult {
  artifactId: string;
  from: ComparedVersion;
  to: ComparedVersion;
  kind: DownloadKind;
  path: string;
  change: FileChange;
  before: ComparedFile | null;
  after: ComparedFile | null;
  diff: FileDiffBody;
}

interface Compared {
  artifact: ArtifactRow;
  from: VersionInfo;
  to: VersionInfo;
}

/**
 * The checks every comparison makes, in order: the artifact exists and the caller may read its
 * history (`versions`; no role answers like a missing artifact), the owner's plan includes
 * `versionDiff`, and both versions are retained versions of this artifact.
 */
async function comparable(db: RegionalDb, input: CompareInput): Promise<Result<Compared>> {
  const managed = await managedArtifact(
    db,
    input.userId,
    input.artifactId,
    "versions",
    missingArtifact,
    input.now,
  );
  if (!managed.ok) return managed;
  const { artifact, owner } = managed.value;
  const gate = requireFeature(owner, "versionDiff");
  if (!gate.ok) return gate;
  const retention: VersionRetention = versionRetention(owner.limits);
  const from = await resolveVersion(db, artifact, input.fromVersionId, retention, input.now);
  const to = await resolveVersion(db, artifact, input.toVersionId, retention, input.now);
  if (!from || !to) return missingVersion();
  return ok({ artifact, from, to });
}

const side = (version: VersionInfo): ComparedVersion => ({
  id: version.id,
  number: version.number,
});

/** Both manifests joined by kind and path (published files and sources, never renderings). */
function joined(fromId: string, toId: string): SQL {
  const files = (id: string) =>
    sql`select "kind", "path", "owner_id", "sha256", "size", "content_type" from "version_files" where "version_id" = ${id} and "kind" in ('published', 'source')`;
  return sql`with "a" as (${files(fromId)}), "b" as (${files(toId)}), "k" as (select "kind", "path" from "a" union select "kind", "path" from "b") select "k"."kind" as "kind", "k"."path" as "path", "a"."owner_id" as "a_owner", "a"."sha256" as "a_sha", "a"."size" as "a_size", "a"."content_type" as "a_type", "b"."owner_id" as "b_owner", "b"."sha256" as "b_sha", "b"."size" as "b_size", "b"."content_type" as "b_type" from "k" left join "a" on "a"."kind" = "k"."kind" and "a"."path" = "k"."path" left join "b" on "b"."kind" = "k"."kind" and "b"."path" = "k"."path"`;
}

interface JoinedRow {
  kind: DownloadKind;
  path: string;
  a_owner: string | null;
  a_sha: string | null;
  a_size: number | null;
  a_type: string | null;
  b_owner: string | null;
  b_sha: string | null;
  b_size: number | null;
  b_type: string | null;
}

function changeOf(row: JoinedRow): FileChange {
  if (row.a_sha === null) return "added";
  if (row.b_sha === null) return "removed";
  return row.a_sha === row.b_sha ? "unchanged" : "changed";
}

function fileOf(sha: string | null, size: number | null, type: string | null): ComparedFile | null {
  return sha === null ? null : { sha256: sha, size: size ?? 0, contentType: type ?? "" };
}

/** Cursor of the file list: the kind and path of the last file on the page, in base64url. */
export function encodeDiffCursor(kind: DownloadKind, path: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([kind, path]));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeDiffCursor(cursor: string): [DownloadKind, string] | undefined {
  try {
    const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
    const value: unknown = JSON.parse(text);
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      (value[0] === "published" || value[0] === "source") &&
      typeof value[1] === "string"
    ) {
      return [value[0], value[1]];
    }
  } catch {
    // Falls through to an invalid cursor.
  }
  return undefined;
}

/**
 * The files that differ between two versions, a page at a time by kind and path, with counts of
 * every kind of change. Reads only the manifests.
 */
export async function compareVersions(
  db: RegionalDb,
  input: CompareInput & { cursor?: string | undefined; limit: number },
): Promise<Result<ComparisonResult>> {
  const after = input.cursor === undefined ? undefined : decodeDiffCursor(input.cursor);
  if (input.cursor !== undefined && after === undefined) {
    return fail("invalid_input", "Invalid cursor.");
  }
  const compared = await comparable(db, input);
  if (!compared.ok) return compared;
  const { artifact, from, to } = compared.value;
  const base = joined(from.id, to.id);
  const [totals] = await db.all<{
    added: number | null;
    removed: number | null;
    changed: number | null;
    unchanged: number | null;
  }>(
    sql`select sum("a_sha" is null) as "added", sum("b_sha" is null) as "removed", sum("a_sha" <> "b_sha") as "changed", sum("a_sha" = "b_sha") as "unchanged" from (${base})`,
  );
  const page = await db.all<JoinedRow>(
    sql`select * from (${base}) where ("a_sha" is null or "b_sha" is null or "a_sha" <> "b_sha")${
      after === undefined ? sql`` : sql` and ("kind", "path") > (${after[0]}, ${after[1]})`
    } order by "kind", "path" limit ${input.limit + 1}`,
  );
  const files = page.slice(0, input.limit).map((row) => ({
    kind: row.kind,
    path: row.path,
    change: changeOf(row) as ComparedEntry["change"],
    before: fileOf(row.a_sha, row.a_size, row.a_type),
    after: fileOf(row.b_sha, row.b_size, row.b_type),
  }));
  const last = files.at(-1);
  return ok({
    artifactId: artifact.id,
    from: side(from),
    to: side(to),
    counts: {
      added: Number(totals?.added ?? 0),
      removed: Number(totals?.removed ?? 0),
      changed: Number(totals?.changed ?? 0),
      unchanged: Number(totals?.unchanged ?? 0),
    },
    files,
    nextCursor: page.length > input.limit && last ? encodeDiffCursor(last.kind, last.path) : null,
  });
}

async function readText(
  bucket: R2Bucket,
  ownerId: string,
  sha256: string,
): Promise<Result<string | null>> {
  const object = await bucket.get(objectKey(ownerId, sha256));
  if (!object) return fail("not_found", "This file's content is no longer stored.");
  return ok(decodeUtf8(new Uint8Array(await object.arrayBuffer())));
}

/**
 * The line diff of one file between two versions, a page of hunks at a time from hunk `cursor`.
 * A missing side counts as empty. Files that are not text, larger than `VERSION_DIFF.fileBytes`,
 * not valid UTF-8 or past the diff's bounds answer why, with their sizes only; nothing is read
 * from storage for a file unchanged, not text or too large.
 */
export async function diffVersionFile(
  db: RegionalDb,
  bucket: R2Bucket,
  input: CompareInput & { kind: DownloadKind; path: string; cursor: number },
): Promise<Result<FileDiffResult>> {
  const normalized = normalizePath(input.path);
  if (!normalized.ok) return fail("invalid_input", normalized.message);
  const path = normalized.value;
  const compared = await comparable(db, input);
  if (!compared.ok) return compared;
  const { artifact, from, to } = compared.value;
  const [row] = await db.all<JoinedRow>(
    sql`select * from (${joined(from.id, to.id)}) where "kind" = ${input.kind} and "path" = ${path}`,
  );
  if (!row) return fail("not_found", "Neither version has this file.");
  const change = changeOf(row);
  const before = fileOf(row.a_sha, row.a_size, row.a_type);
  const after = fileOf(row.b_sha, row.b_size, row.b_type);
  const result = (diff: FileDiffBody): Result<FileDiffResult> =>
    ok({
      artifactId: artifact.id,
      from: side(from),
      to: side(to),
      kind: input.kind,
      path,
      change,
      before,
      after,
      diff,
    });
  if (change === "unchanged") return result({ status: "identical" });
  const eligibility = [textDiffEligibility(before), textDiffEligibility(after)];
  if (eligibility.includes("binary")) return result({ status: "binary" });
  if (eligibility.includes("too_large")) return result({ status: "too_large" });
  let beforeText = "";
  let afterText = "";
  if (row.a_owner !== null && row.a_sha !== null) {
    const text = await readText(bucket, row.a_owner, row.a_sha);
    if (!text.ok) return text;
    if (text.value === null) return result({ status: "binary" });
    beforeText = text.value;
  }
  if (row.b_owner !== null && row.b_sha !== null) {
    const text = await readText(bucket, row.b_owner, row.b_sha);
    if (!text.ok) return text;
    if (text.value === null) return result({ status: "binary" });
    afterText = text.value;
  }
  const diff = diffText(beforeText, afterText, VERSION_DIFF);
  if (diff.status !== "text") return result({ status: diff.status });
  const page = pageHunks(diff.hunks, input.cursor, VERSION_DIFF.pageLines);
  return result({
    status: "text",
    added: diff.added,
    removed: diff.removed,
    hunks: page.hunks,
    nextCursor: page.nextCursor,
  });
}
