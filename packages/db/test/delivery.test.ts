import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  findDeliveryArtifact,
  findPublishedFile,
  findRenderedPage,
  schema,
} from "../src/index.ts";

const db = () => createDb(env.DB);
const sha = (c: string) => c.repeat(64);

describe("delivery queries", () => {
  beforeEach(async () => {
    for (const table of ["version_files", "versions", "objects", "artifacts"]) {
      await env.DB.exec(`DELETE FROM ${table}`);
    }
    await db().insert(schema.artifacts).values({
      id: "k7d2qm4xab",
      ownerId: "u_owner",
      type: "site",
      name: "Report",
      state: "active",
      accessMode: "public",
      currentVersionId: "v1",
    });
    await db().insert(schema.versions).values({
      id: "v1",
      artifactId: "k7d2qm4xab",
      number: 1,
      authorId: "u_owner",
      entrypoint: "index.html",
      publishedBytes: 20,
    });
    await db()
      .insert(schema.objects)
      .values([
        { ownerId: "u_owner", sha256: sha("a"), size: 10, r2Key: "o/a", state: "verified" },
        { ownerId: "u_owner", sha256: sha("b"), size: 10, r2Key: "o/b", state: "pending" },
      ]);
    const file = { versionId: "v1", ownerId: "u_owner", size: 10, contentType: "text/html" };
    await db()
      .insert(schema.versionFiles)
      .values([
        { ...file, kind: "published", path: "index.html", sha256: sha("a") },
        { ...file, kind: "published", path: "draft.html", sha256: sha("b") },
        { ...file, kind: "source", path: "src/index.ts", sha256: sha("a") },
        { ...file, kind: "rendered", path: "index.md", sha256: sha("a") },
        { ...file, kind: "block_map", path: "index.json", sha256: sha("a") },
      ]);
  });

  it("finds the artifact with what delivery needs", async () => {
    expect(await findDeliveryArtifact(db(), "k7d2qm4xab")).toMatchObject({
      id: "k7d2qm4xab",
      state: "active",
      accessMode: "public",
      currentVersionId: "v1",
      entrypoint: "index.html",
      indexable: false,
    });
    expect(await findDeliveryArtifact(db(), "zzzzzzzzzz")).toBeNull();
  });

  it("has no entrypoint before the first version is current", async () => {
    await env.DB.exec("UPDATE artifacts SET current_version_id = NULL");
    expect(await findDeliveryArtifact(db(), "k7d2qm4xab")).toMatchObject({
      currentVersionId: null,
      entrypoint: null,
    });
  });

  it("finds the rendered page of a document by its entrypoint", async () => {
    expect(await findRenderedPage(db(), "v1", "index.md")).toEqual({
      path: "index.md",
      sha256: sha("a"),
      size: 10,
      contentType: "text/html",
      r2Key: "o/a",
    });
    expect(await findRenderedPage(db(), "v1", "index.html")).toBeNull();
    expect(await findPublishedFile(db(), "v1", "index.md")).toBeNull();
  });

  it("finds a published file with the R2 key of its verified object", async () => {
    expect(await findPublishedFile(db(), "v1", "index.html")).toEqual({
      path: "index.html",
      sha256: sha("a"),
      size: 10,
      contentType: "text/html",
      r2Key: "o/a",
    });
  });

  it("never serves private sources, unverified objects or other versions", async () => {
    expect(await findPublishedFile(db(), "v1", "src/index.ts")).toBeNull();
    expect(await findPublishedFile(db(), "v1", "draft.html")).toBeNull();
    expect(await findPublishedFile(db(), "v2", "index.html")).toBeNull();
    expect(await findPublishedFile(db(), "v1", "index.json")).toBeNull();
  });
});
