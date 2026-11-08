import { env } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, schema } from "../src/index.ts";

const db = () => createDb(env.DB);
const now = Date.UTC(2026, 10, 8);

async function insertArtifact(id = "k7d2qm4xab", ownerId = "u_owner") {
  await db().insert(schema.artifacts).values({ id, ownerId, type: "site", name: "Report" });
}

/** Asserts the database refused the statement; Drizzle wraps the SQLite error in `cause`. */
async function rejects(statement: Promise<unknown>, pattern: RegExp) {
  const error = await statement.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "the statement should have been rejected").toBeInstanceOf(Error);
  const messages: string[] = [];
  for (let e: unknown = error; e instanceof Error; e = e.cause) messages.push(e.message);
  expect(messages.join("\n")).toMatch(pattern);
}

describe("control database schema", () => {
  beforeEach(async () => {
    for (const table of [
      "version_files",
      "versions",
      "artifact_readers",
      "artifacts",
      "account_usage",
      "objects",
    ]) {
      await env.DB.exec(`DELETE FROM ${table}`);
    }
  });

  it("creates artifacts private, unannotated and in draft by default", async () => {
    await insertArtifact();
    const [row] = await db().select().from(schema.artifacts);
    expect(row).toMatchObject({
      state: "draft",
      accessMode: "restricted",
      annotations: "off",
      indexable: false,
      embeddable: false,
      policyGeneration: 1,
      lifecycleGeneration: 1,
    });
    expect(row?.createdAt).toBeGreaterThan(0);
  });

  it("only accepts 10-character artifact ids and non-empty names", async () => {
    await rejects(insertArtifact("short"), /CHECK constraint failed/);
    await rejects(
      db()
        .insert(schema.artifacts)
        .values({ id: "k7d2qm4xab", ownerId: "u", type: "text", name: "" }),
      /CHECK constraint failed/,
    );
  });

  it("stores reader emails in lowercase only, once per artifact", async () => {
    await insertArtifact();
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: "k7d2qm4xab", email: "ana@example.com" });
    await rejects(
      db()
        .insert(schema.artifactReaders)
        .values({ artifactId: "k7d2qm4xab", email: "Ana@Example.com" }),
      /CHECK constraint failed/,
    );
    await rejects(
      db()
        .insert(schema.artifactReaders)
        .values({ artifactId: "k7d2qm4xab", email: "ana@example.com" }),
      /UNIQUE constraint failed/,
    );
  });

  it("numbers versions uniquely per artifact", async () => {
    await insertArtifact();
    const version = (id: string, number: number) => ({
      id,
      artifactId: "k7d2qm4xab",
      number,
      authorId: "u_owner",
      entrypoint: "index.html",
      publishedBytes: 10,
    });
    await db().insert(schema.versions).values(version("v1", 1));
    await rejects(
      db().insert(schema.versions).values(version("v2", 1)),
      /UNIQUE constraint failed/,
    );
  });

  it("deletes readers, versions and manifest entries with their artifact", async () => {
    await insertArtifact();
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: "k7d2qm4xab", email: "ana@example.com" });
    await db().insert(schema.versions).values({
      id: "v1",
      artifactId: "k7d2qm4xab",
      number: 1,
      authorId: "u_owner",
      entrypoint: "index.html",
      publishedBytes: 10,
    });
    await db()
      .insert(schema.versionFiles)
      .values({
        versionId: "v1",
        kind: "published",
        path: "index.html",
        ownerId: "u_owner",
        sha256: "a".repeat(64),
        size: 10,
        contentType: "text/html",
      });

    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, "k7d2qm4xab"));

    for (const table of [schema.artifactReaders, schema.versions, schema.versionFiles]) {
      const [count] = await db().select({ n: sql<number>`count(*)` }).from(table);
      expect(count?.n).toBe(0);
    }
  });

  it("enforces the account limits in the database, so concurrent admissions cannot overshoot", async () => {
    await db()
      .insert(schema.accountUsage)
      .values({ ownerId: "u_owner", activeArtifacts: 49, monthStartedAt: now });
    const takeSlot = () =>
      env.DB.prepare(
        "UPDATE account_usage SET active_artifacts = active_artifacts + 1 WHERE owner_id = ?",
      )
        .bind("u_owner")
        .run();

    const results = await Promise.allSettled([takeSlot(), takeSlot(), takeSlot()]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [row] = await db().select().from(schema.accountUsage);
    expect(row?.activeArtifacts).toBe(50);
  });

  it("refuses opening a third upload but always lets uploads close", async () => {
    await db()
      .insert(schema.accountUsage)
      .values({ ownerId: "u_owner", openUploads: 1, monthStartedAt: now });
    const change = (delta: number) =>
      env.DB.prepare("UPDATE account_usage SET open_uploads = open_uploads + ? WHERE owner_id = ?")
        .bind(delta, "u_owner")
        .run();

    await change(1);
    await rejects(change(1), /account_usage_open_uploads_limit/);
    await change(-1);
    const [row] = await db().select().from(schema.accountUsage);
    expect(row?.openUploads).toBe(1);
  });

  it("lets an account above the open uploads limit close them but not open more", async () => {
    // Possible only for rows written before the trigger existed.
    await db()
      .insert(schema.accountUsage)
      .values({ ownerId: "u_owner", openUploads: 3, monthStartedAt: now });
    const change = (delta: number) =>
      env.DB.prepare("UPDATE account_usage SET open_uploads = open_uploads + ? WHERE owner_id = ?")
        .bind(delta, "u_owner")
        .run();

    await rejects(change(1), /account_usage_open_uploads_limit/);
    await change(-1);
    const [row] = await db().select().from(schema.accountUsage);
    expect(row?.openUploads).toBe(2);
  });

  it("rejects storage beyond 2.5 GB including reservations", async () => {
    await rejects(
      db().insert(schema.accountUsage).values({
        ownerId: "u",
        storedBytes: 2_000_000_000,
        reservedBytes: 500_000_001,
        monthStartedAt: now,
      }),
      /CHECK constraint failed/,
    );
    await rejects(
      db()
        .insert(schema.accountUsage)
        .values({ ownerId: "u", openUploads: -1, monthStartedAt: now }),
      /CHECK constraint failed/,
    );
  });

  it("deduplicates objects per account by content hash", async () => {
    const object = {
      ownerId: "u_owner",
      sha256: "b".repeat(64),
      size: 5,
      r2Key: "objects/u_owner/bbb",
    };
    await db().insert(schema.objects).values(object);
    await rejects(
      db()
        .insert(schema.objects)
        .values({ ...object, r2Key: "other" }),
      /UNIQUE constraint failed/,
    );
    await db()
      .insert(schema.objects)
      .values({ ...object, ownerId: "u_other", r2Key: "objects/u_other/bbb" });
    await rejects(
      db()
        .insert(schema.objects)
        .values({ ...object, ownerId: "u_x", sha256: "short", r2Key: "x" }),
      /CHECK constraint failed/,
    );
  });
});
