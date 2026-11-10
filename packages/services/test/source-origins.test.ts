// The declared git origin of a version's sources: stored at prepare, owner-only through the
// version reads, copied by a rollback and deleted with its version.
import { env } from "cloudflare:test";
import { regionsFromEnv } from "@portifact/db";
import type { SourceOriginInput } from "@portifact/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { pruneVersions } from "../src/maintenance.ts";
import { commitPublish, type ManifestEntry, preparePublish } from "../src/publish.ts";
import { getVersionManifest, listVersions, rollbackArtifact } from "../src/versions.ts";

const OWNER = "u_owner";
const NOW = Date.UTC(2026, 10, 8, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const db = () => regionsFromEnv(env).get("default").db;

const ORIGIN = {
  commit: "0123456789abcdef0123456789abcdef01234567",
  branch: "main",
  remote: "https://github.com/leynier/portifact.git",
  dirty: true,
};

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function entry(path: string, kind: "published" | "source", body: string) {
  return {
    path,
    kind,
    sha256: await sha256(body),
    size: body.length,
    contentType: "text/plain",
  } satisfies ManifestEntry;
}

async function publish(options: {
  page: string;
  source?: string;
  origin?: SourceOriginInput;
  artifactId?: string;
  base?: string | null;
  now?: number;
}) {
  const now = options.now ?? NOW;
  const files = [await entry("index.html", "published", options.page)];
  if (options.source !== undefined) files.push(await entry("src/app.ts", "source", options.source));
  const prepared = await preparePublish(db(), {
    userId: OWNER,
    ...(options.artifactId ? { artifactId: options.artifactId } : {}),
    type: "site",
    name: "Site",
    entrypoint: "index.html",
    baseVersionId: options.base ?? null,
    files,
    sourceOrigin: options.origin,
    now,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  for (const body of [options.page, options.source]) {
    if (body === undefined) continue;
    const hash = await sha256(body);
    await env.ARTIFACTS.put(`objects/${OWNER}/${hash}`, body, { sha256: hash });
  }
  const committed = await commitPublish(db(), env.ARTIFACTS, {
    userId: OWNER,
    sessionId: prepared.value.sessionId,
    now,
  });
  if (!committed.ok) throw new Error(committed.message);
  return committed.value;
}

async function origins(): Promise<number> {
  const row = await env.DB.prepare("select count(*) as n from source_origins").first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  for (const table of [
    "source_origins",
    "version_files",
    "versions",
    "objects",
    "artifacts",
    "upload_sessions",
    "account_usage",
    "usage_events",
    "lifecycle_events",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
});

describe("source origin", () => {
  it("is stored with the version and returned in its listing and manifest", async () => {
    const published = await publish({ page: "<p>1</p>", source: "let a = 1;", origin: ORIGIN });
    const page = await listVersions(db(), {
      userId: OWNER,
      artifactId: published.artifactId,
      now: NOW,
      limit: 10,
    });
    if (!page.ok) throw new Error(page.message);
    expect(page.value.items[0]?.sourceOrigin).toEqual(ORIGIN);
    const manifest = await getVersionManifest(db(), {
      userId: OWNER,
      artifactId: published.artifactId,
      versionId: "current",
      now: NOW,
    });
    if (!manifest.ok) throw new Error(manifest.message);
    expect(manifest.value.version.sourceOrigin).toEqual(ORIGIN);
  });

  it("is null for a version published without one, and keeps null fields", async () => {
    const first = await publish({ page: "<p>1</p>", source: "x" });
    const second = await publish({
      page: "<p>2</p>",
      source: "y",
      origin: { commit: null, branch: null, remote: null, dirty: false },
      artifactId: first.artifactId,
      base: first.versionId,
      now: NOW + HOUR,
    });
    const page = await listVersions(db(), {
      userId: OWNER,
      artifactId: first.artifactId,
      now: NOW + HOUR,
      limit: 10,
    });
    if (!page.ok) throw new Error(page.message);
    expect(page.value.items.map((item) => [item.id, item.sourceOrigin])).toEqual([
      [second.versionId, { commit: null, branch: null, remote: null, dirty: false }],
      [first.versionId, null],
    ]);
  });

  it("is refused without source files, or with credentials in the remote, before anything is stored", async () => {
    const files = [await entry("index.html", "published", "<p>1</p>")];
    const base = {
      userId: OWNER,
      type: "site" as const,
      name: "Site",
      entrypoint: "index.html",
      baseVersionId: null,
      now: NOW,
    };
    expect(await preparePublish(db(), { ...base, files, sourceOrigin: ORIGIN })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    const withSource = [...files, await entry("src/a.ts", "source", "a")];
    expect(
      await preparePublish(db(), {
        ...base,
        files: withSource,
        sourceOrigin: { ...ORIGIN, remote: "https://ghp_token@github.com/o/r.git" },
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await origins()).toBe(0);
    const row = await env.DB.prepare("select count(*) as n from versions").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("comes along with the sources on a rollback", async () => {
    const v1 = await publish({ page: "<p>1</p>", source: "one", origin: ORIGIN });
    const v2 = await publish({
      page: "<p>2</p>",
      artifactId: v1.artifactId,
      base: v1.versionId,
      now: NOW + HOUR,
    });
    const rolled = await rollbackArtifact(db(), {
      userId: OWNER,
      artifactId: v1.artifactId,
      versionId: v1.versionId,
      baseVersionId: v2.versionId,
      now: NOW + 2 * HOUR,
    });
    if (!rolled.ok) throw new Error(rolled.message);
    const manifest = await getVersionManifest(db(), {
      userId: OWNER,
      artifactId: v1.artifactId,
      versionId: rolled.value.versionId,
      now: NOW + 2 * HOUR,
    });
    if (!manifest.ok) throw new Error(manifest.message);
    expect(manifest.value.version.sourceOrigin).toEqual(ORIGIN);
    expect(await origins()).toBe(2);

    // A rollback that conflicts copies nothing.
    const stale = await rollbackArtifact(db(), {
      userId: OWNER,
      artifactId: v1.artifactId,
      versionId: v1.versionId,
      baseVersionId: v2.versionId,
      now: NOW + 2 * HOUR,
    });
    expect(stale).toMatchObject({ ok: false, code: "version_conflict" });
    expect(await origins()).toBe(2);
  });

  it("is deleted with its version when the version is pruned", async () => {
    const v1 = await publish({ page: "<p>1</p>", source: "one", origin: ORIGIN });
    await publish({
      page: "<p>2</p>",
      artifactId: v1.artifactId,
      base: v1.versionId,
      now: NOW + HOUR,
    });
    expect(await origins()).toBe(1);
    await pruneVersions(db(), env.ARTIFACTS, NOW + HOUR + 8 * DAY);
    expect(await origins()).toBe(0);
  });
});
