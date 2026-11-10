// portifact versions and portifact rollback. Both are thin calls to the version API; the server
// decides what is retained and applies the rollback under its base-version check.
import { randomUUID } from "node:crypto";
import {
  ArtifactSummary,
  RolledBack,
  VersionList,
  VersionRef,
  type VersionSummary,
} from "@portifact/contracts";
import { callApi, withRetries } from "./api.ts";
import { parseArtifactId, table } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { formatBytes, formatDate, messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";
import type { Session } from "./session.ts";

/** Versions asked for per request; the command follows the cursor until the last page. */
const PAGE_SIZE = 100;

export function parseVersionId(value: string): string {
  const parsed = VersionRef.safeParse(value.trim());
  if (!parsed.success) throw new CliError("invalid_input", messages.errors.invalidVersionId(value));
  return parsed.data;
}

/** Version IDs never look like this, so `3` or `v3` is always the version number. */
const VERSION_NUMBER = /^v?([0-9]{1,9})$/i;

/** A version argument given as its ID or as its number, checked before signing in. */
export type VersionArg = { id: string } | { number: number };

export function parseVersionArg(value: string): VersionArg {
  const match = VERSION_NUMBER.exec(value.trim());
  if (!match) return { id: parseVersionId(value) };
  const number = Number(match[1]);
  if (number < 1) throw new CliError("invalid_input", messages.errors.invalidVersionId(value));
  return { number };
}

/** The ID of a version argument; a number is looked up in the artifact's retained versions. */
export async function resolveVersionArg(
  session: Session,
  artifactId: string,
  arg: VersionArg,
): Promise<string> {
  if ("id" in arg) return arg.id;
  const items = await listAllVersions(session, artifactId);
  const match = items.find((item) => item.number === arg.number);
  if (!match) {
    throw new CliError("not_found", messages.errors.versionNumberNotFound(artifactId, arg.number));
  }
  return match.id;
}

export async function versions(
  io: Io,
  runtime: Runtime,
  id: string,
  options: OutputOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const session = await openSession(io, runtime);
  const { items, retention } = await listAllVersionsWithRetention(session, artifactId);

  if (options.json) {
    writeJson(io, { artifactId, items, retention });
    return;
  }
  if (items.length === 0) {
    io.stdout(`${messages.versionsEmpty(artifactId)}\n`);
    return;
  }
  io.stdout(
    table([
      ["VERSION", "ID", "CURRENT", "FILES", "SOURCES", "SIZE", "COMMITTED", "RETAINED UNTIL"],
      ...items.map((item) => [
        String(item.number),
        item.id,
        item.current ? "yes" : "no",
        String(item.publishedFiles),
        String(item.sourceFiles),
        formatBytes(item.publishedBytes + item.sourceBytes),
        formatDate(item.committedAt),
        item.current ? "current" : formatDate(item.expiresAt),
      ]),
    ]),
  );
  io.stdout(`${messages.versionsRetention(retention.previousVersions, retention.days)}\n`);
}

/** Every retained version of the artifact, newest first, following the cursor to the last page. */
export async function listAllVersions(
  session: Session,
  artifactId: string,
): Promise<VersionSummary[]> {
  return (await listAllVersionsWithRetention(session, artifactId)).items;
}

/** Every retained version and what the owner's plan keeps. */
async function listAllVersionsWithRetention(
  session: Session,
  artifactId: string,
): Promise<{ items: VersionSummary[]; retention: VersionList["retention"] }> {
  const items: VersionSummary[] = [];
  let retention: VersionList["retention"] | undefined;
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor !== null) query.set("cursor", cursor);
    const page: VersionList = await callApi(session, {
      method: "GET",
      path: `/artifacts/${artifactId}/versions?${query}`,
      schema: VersionList,
    });
    items.push(...page.items);
    retention ??= page.retention;
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { items, retention: retention as VersionList["retention"] };
}

export async function rollback(
  io: Io,
  runtime: Runtime,
  id: string,
  version: string,
  options: OutputOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const target = parseVersionArg(version);
  const session = await openSession(io, runtime);
  const versionId = await resolveVersionArg(session, artifactId, target);
  // The base is the version current right now; a publish in between makes this a conflict.
  const artifact = await callApi(session, {
    method: "GET",
    path: `/artifacts/${artifactId}`,
    schema: ArtifactSummary,
  });
  if (artifact.currentVersionId === null) {
    throw new CliError("not_found", messages.errors.noCurrentVersion(artifactId));
  }
  // One key for every attempt, so a retry after a lost answer returns the first result.
  const idempotencyKey = randomUUID();
  const result = await withRetries(session, () =>
    callApi(session, {
      method: "POST",
      path: `/artifacts/${artifactId}/rollback`,
      headers: { "idempotency-key": idempotencyKey },
      body: { versionId, baseVersionId: artifact.currentVersionId },
      schema: RolledBack,
    }),
  );
  if (options.json) {
    writeJson(io, result);
    return;
  }
  io.stdout(
    `${messages.rolledBack(artifactId, result.versionNumber, result.fromVersionNumber, result.url, result.expiresAt)}\n`,
  );
}
