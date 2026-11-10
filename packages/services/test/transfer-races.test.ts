// A write authorized on an artifact's old owner must not apply once the artifact moved: Zed is an
// admin of two workspaces, Eve an editor of the first only, and Zed moves the artifact to the
// second between Eve's reads and her write.
import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateAccess } from "../src/access.ts";
import { deleteArtifact, renewArtifact } from "../src/lifecycle.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { createShareLink, revokeShareLink } from "../src/share-links.ts";
import { transferArtifact } from "../src/transfer.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { db, grantPlan, NOW, sha256, user, value } from "./fixtures.ts";
import { raceBeforeFirstWrite } from "./race.ts";

async function setup() {
  const [zed, eve] = [await user("Zed"), await user("Eve")];
  const make = async (name: string) => {
    const ws = value(
      await createWorkspace(db().global, {
        slug: `${name}-${crypto.randomUUID().slice(0, 8)}`,
        name,
        adminUserId: zed.id,
        now: NOW,
      }),
    );
    await grantPlan(ws.id, "team", { seats: 5 });
    return ws;
  };
  const [w1, w2] = [await make("one"), await make("two")];
  await db()
    .insert(schema.workspaceMembers)
    .values({ workspaceId: w1.id, userId: eve.id, role: "editor", updatedAt: NOW });
  const body = `<p>${crypto.randomUUID()}</p>`;
  const prepared = value(
    await preparePublish(db(), {
      userId: zed.id,
      targetOwnerId: w1.id,
      type: "site",
      name: "X",
      entrypoint: "index.html",
      baseVersionId: null,
      files: [
        {
          path: "index.html",
          kind: "published",
          sha256: await sha256(body),
          size: body.length,
          contentType: "text/html",
        },
      ],
      now: NOW,
    }),
  );
  await env.ARTIFACTS.put(`objects/${w1.id}/${await sha256(body)}`, body);
  const { artifactId } = value(
    await commitPublish(db(), env.ARTIFACTS, {
      userId: zed.id,
      sessionId: prepared.sessionId,
      now: NOW,
    }),
  );
  const moveToW2 = async () => {
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: zed.id,
        artifactId,
        workspace: w2.slug,
        now: NOW,
      }),
    );
  };
  return { zed, eve, w1, w2, artifactId, moveToW2 };
}

async function artifact(id: string) {
  const [row] = await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
  return row;
}

describe("a transfer racing a write authorized on the old owner", () => {
  it("keeps the deletion from purging the artifact in its new space", async () => {
    const t = await setup();
    const raced = raceBeforeFirstWrite(t.moveToW2);
    const result = await deleteArtifact(raced, env.ARTIFACTS, {
      userId: t.eve.id,
      artifactId: t.artifactId,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(await artifact(t.artifactId)).toMatchObject({ ownerId: t.w2.id, state: "active" });
  });

  it("keeps a renewal from applying", async () => {
    const t = await setup();
    const before = await artifact(t.artifactId);
    const raced = raceBeforeFirstWrite(t.moveToW2);
    const result = await renewArtifact(raced, {
      userId: t.eve.id,
      artifactId: t.artifactId,
      now: NOW + 1000,
    });
    expect(result.ok).toBe(false);
    expect((await artifact(t.artifactId))?.expiresAt).toBe(before?.expiresAt);
  });

  it("keeps access from widening", async () => {
    const t = await setup();
    const raced = raceBeforeFirstWrite(t.moveToW2);
    const result = await updateAccess(raced, {
      userId: t.eve.id,
      artifactId: t.artifactId,
      change: { mode: "public" },
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect((await artifact(t.artifactId))?.accessMode).toBe("restricted");
  });

  it("keeps a share link from being created, or revoked", async () => {
    const t = await setup();
    const raced = raceBeforeFirstWrite(t.moveToW2);
    const result = await createShareLink(raced, {
      userId: t.eve.id,
      artifactId: t.artifactId,
      label: "leak",
      expiresAt: null,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(
      await db()
        .select()
        .from(schema.shareLinks)
        .where(eq(schema.shareLinks.artifactId, t.artifactId)),
    ).toEqual([]);

    const u = await setup();
    const { link } = value(
      await createShareLink(db(), {
        userId: u.zed.id,
        artifactId: u.artifactId,
        label: "kept",
        expiresAt: null,
        now: NOW,
      }),
    );
    const revoked = await revokeShareLink(raceBeforeFirstWrite(u.moveToW2), {
      userId: u.eve.id,
      artifactId: u.artifactId,
      linkId: link.id,
      now: NOW,
    });
    expect(revoked.ok).toBe(false);
    const [row] = await db()
      .select({ revokedAt: schema.shareLinks.revokedAt })
      .from(schema.shareLinks)
      .where(eq(schema.shareLinks.id, link.id));
    expect(row?.revokedAt).toBeNull();
  });

  it("ends the artifact's sessions: the move bumps both generations", async () => {
    const t = await setup();
    const before = await artifact(t.artifactId);
    await t.moveToW2();
    const after = await artifact(t.artifactId);
    expect(after?.lifecycleGeneration).toBe((before?.lifecycleGeneration ?? 0) + 1);
    expect(after?.policyGeneration).toBe((before?.policyGeneration ?? 0) + 1);
  });

  // Claims are global and the move regional (decision 0005): no batch holds both, so a claim that
  // lands between the check and the move is released after it, never left with the old owner.
  it("releases a custom domain claim that landed while the artifact moved", async () => {
    const t = await setup();
    const raced = raceBeforeFirstWrite(async () => {
      await db()
        .insert(schema.domainClaims)
        .values({
          hostname: `x-${crypto.randomUUID().slice(0, 6)}.example.test`,
          ownerId: t.w1.id,
          artifactId: t.artifactId,
          region: "default",
          token: "t",
          expiresAt: NOW + 86_400_000,
        });
    });
    const result = await transferArtifact(raced, env.ARTIFACTS, {
      userId: t.zed.id,
      artifactId: t.artifactId,
      workspace: t.w2.slug,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(await artifact(t.artifactId)).toMatchObject({ ownerId: t.w2.id });
    expect(
      await db()
        .global.select()
        .from(schema.domainClaims)
        .where(eq(schema.domainClaims.artifactId, t.artifactId)),
    ).toEqual([]);
  });
});
