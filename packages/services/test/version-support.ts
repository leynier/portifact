// Publishing several versions of one artifact, with any files, for the retention and comparison
// tests. Every version goes through the real prepare and commit.
import { env } from "cloudflare:test";
import type { ArtifactType } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { db, NOW, value } from "./fixtures.ts";

export interface FileSpec {
  body: string | Uint8Array;
  contentType?: string;
  kind?: "published" | "source";
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Published {
  artifactId: string;
  versionId: string;
}

/**
 * Publishes `files` as a new version: the first version of a new artifact in `ownerId` without
 * `base`, or the next version of `base`.
 */
export async function publishVersion(
  userId: string,
  files: Record<string, string | FileSpec>,
  options: {
    now?: number;
    base?: Published;
    ownerId?: string;
    type?: ArtifactType;
    entrypoint?: string;
  } = {},
): Promise<Published> {
  const ownerId = options.ownerId ?? userId;
  const entries = await Promise.all(
    Object.entries(files).map(async ([path, spec]) => {
      const file = typeof spec === "string" ? { body: spec } : spec;
      const bytes = typeof file.body === "string" ? new TextEncoder().encode(file.body) : file.body;
      return {
        bytes,
        entry: {
          path,
          kind: file.kind ?? ("published" as const),
          sha256: await digest(bytes),
          size: bytes.byteLength,
          contentType: file.contentType ?? "text/html",
        },
      };
    }),
  );
  const now = options.now ?? NOW;
  const prepared = value(
    await preparePublish(db(), {
      userId,
      ...(ownerId === userId ? {} : { targetOwnerId: ownerId }),
      type: options.type ?? "site",
      name: "Versions",
      entrypoint: options.entrypoint ?? "index.html",
      baseVersionId: options.base?.versionId ?? null,
      ...(options.base ? { artifactId: options.base.artifactId } : {}),
      files: entries.map((file) => file.entry),
      now,
    }),
  );
  for (const file of entries) {
    await env.ARTIFACTS.put(`objects/${ownerId}/${file.entry.sha256}`, file.bytes);
  }
  const committed = value(
    await commitPublish(db(), env.ARTIFACTS, { userId, sessionId: prepared.sessionId, now }),
  );
  return { artifactId: committed.artifactId, versionId: committed.versionId };
}

/** Publishes `count` versions of one site, an hour apart from `now`, each with its own bytes. */
export async function versions(
  userId: string,
  count: number,
  options: { now?: number; ownerId?: string } = {},
): Promise<Published[]> {
  const out: Published[] = [];
  const start = options.now ?? NOW;
  for (let i = 0; i < count; i++) {
    const base = out.at(-1);
    out.push(
      await publishVersion(
        userId,
        { "index.html": `<p>version ${i + 1} ${crypto.randomUUID()}</p>` },
        {
          now: start + i * 3_600_000,
          ...(base ? { base } : {}),
          ...(options.ownerId ? { ownerId: options.ownerId } : {}),
        },
      ),
    );
  }
  return out;
}

export async function storedBytes(ownerId: string): Promise<number> {
  const [row] = await db()
    .select({ bytes: schema.accountUsage.storedBytes })
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, ownerId));
  return row?.bytes ?? 0;
}

export async function versionRows(artifactId: string): Promise<number[]> {
  return (
    await db()
      .select({ number: schema.versions.number })
      .from(schema.versions)
      .where(eq(schema.versions.artifactId, artifactId))
  )
    .map((row) => row.number)
    .sort((a, b) => a - b);
}

/** A workspace with an admin, an editor, a member and a user outside it. */
export async function workspace(users: () => Promise<{ id: string }>) {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  const [admin, editor, member, outsider] = [
    await users(),
    await users(),
    await users(),
    await users(),
  ];
  await db()
    .insert(schema.workspaces)
    .values({ id, slug: id.slice(3, 23), name: "Team", createdBy: admin.id, updatedAt: NOW });
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: admin.id, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: id, userId: member.id, role: "member", updatedAt: NOW },
    ]);
  return { id, admin, editor, member, outsider };
}
