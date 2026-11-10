// Creating and deleting workspaces (operator only) and their plans: a deletion claims every
// artifact, removes memberships and invitations at once, and the jobs finish it with a `workspace`
// tombstone; tombstones re-apply it after a restore.
import { env } from "cloudflare:test";
import type { JobMessage } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { actorOn } from "../src/actors.ts";
import { applyTombstones, exportTombstones } from "../src/backups.ts";
import { runJob } from "../src/outbox.ts";
import { getOwnerPlan, setOwnerPlan } from "../src/plans.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import {
  advanceWorkspaceDeletion,
  createWorkspace,
  deleteWorkspace,
  getWorkspaceDetail,
  listAllWorkspaces,
  processWorkspaceDeletions,
} from "../src/workspaces.ts";
import { DAY, db, NOW, sha256, user, value } from "./fixtures.ts";

async function newWorkspace() {
  const admin = await user();
  const slug = `d-${crypto.randomUUID().slice(0, 8)}`;
  const ws = value(
    await createWorkspace(db().global, { slug, name: "Doomed", adminUserId: admin.id, now: NOW }),
  );
  return { ws, admin };
}

async function publishInto(userId: string, ownerId: string) {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const prepared = value(
    await preparePublish(db(), {
      userId,
      targetOwnerId: ownerId,
      type: "site",
      name: "Plan",
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
  const key = `objects/${ownerId}/${await sha256(body)}`;
  await env.ARTIFACTS.put(key, body);
  const committed = value(
    await commitPublish(db(), env.ARTIFACTS, { userId, sessionId: prepared.sessionId, now: NOW }),
  );
  return { artifactId: committed.artifactId, key };
}

/** Runs every outbox job about the workspace or its artifacts until none is left. */
async function drain(now: number) {
  for (let round = 0; round < 10; round += 1) {
    const rows = await db().select().from(schema.outbox);
    if (rows.length === 0) return;
    for (const row of rows) {
      await runJob(db(), env.ARTIFACTS, { id: row.id, topic: row.topic } as JobMessage, now, {
        access: regionsFromEnv(env).get("default").accessDb,
      });
    }
  }
}

describe("creating a workspace", () => {
  it("creates it with its first admin, and refuses a taken slug or a missing account", async () => {
    const { ws, admin } = await newWorkspace();
    expect(await actorOn(db().global, admin.id, ws.id)).toMatchObject({ role: "admin" });
    expect(
      await createWorkspace(db().global, {
        slug: ws.slug,
        name: "Again",
        adminUserId: admin.id,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "invalid_input", message: `The slug ${ws.slug} is taken.` });
    expect(
      await createWorkspace(db().global, {
        slug: `n-${crypto.randomUUID().slice(0, 8)}`,
        name: "Nobody",
        adminUserId: "u_missing",
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "not_found", message: "Account not found." });
    expect(
      await createWorkspace(db().global, {
        slug: "Bad Slug",
        name: "x",
        adminUserId: admin.id,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    const listed = await listAllWorkspaces(db().global);
    expect(listed.find((row) => row.id === ws.id)).toMatchObject({ slug: ws.slug, members: 1 });
    const detail = await getWorkspaceDetail(regionsFromEnv(env), ws.slug, NOW);
    expect(detail).toMatchObject({
      id: ws.id,
      createdBy: admin.id,
      seats: { used: 1, limit: 1 },
      artifacts: 0,
    });
    expect(await getWorkspaceDetail(regionsFromEnv(env), ws.id, NOW)).toMatchObject({
      slug: ws.slug,
    });
    expect(await getWorkspaceDetail(regionsFromEnv(env), "no-such", NOW)).toBeNull();
  });

  it("takes a plan like an account, with seats, until it is deleted", async () => {
    const { ws } = await newWorkspace();
    const grant = (now = NOW) =>
      setOwnerPlan(db(), {
        ownerId: ws.id,
        plan: "team",
        seats: 3,
        validUntil: null,
        overrides: null,
        grantedBy: "operator",
        note: null,
        now,
      });
    expect(value(await grant()).entitlements).toMatchObject({ plan: "team", seats: 3 });
    expect((await getOwnerPlan(db(), ws.id, NOW)).account?.activeLimit).toBe(2000);
    value(await deleteWorkspace(regionsFromEnv(env), { workspaceId: ws.id, now: NOW }));
    expect(await grant()).toEqual({
      ok: false,
      code: "not_found",
      message: "Account or workspace not found.",
    });
  });
});

describe("deleting a workspace", () => {
  it("claims its artifacts, ends memberships and invitations at once, and the jobs finish it", async () => {
    const { ws, admin } = await newWorkspace();
    const { artifactId, key } = await publishInto(admin.id, ws.id);
    expect((await getWorkspaceDetail(regionsFromEnv(env), ws.id, NOW))?.artifacts).toBe(1);
    await db()
      .insert(schema.workspaceInvitations)
      .values({
        id: `inv_${crypto.randomUUID().replaceAll("-", "")}`,
        workspaceId: ws.id,
        email: "late@example.test",
        role: "member",
        tokenHash: crypto.randomUUID(),
        createdAt: NOW,
        expiresAt: NOW + DAY,
      });

    expect(
      value(await deleteWorkspace(regionsFromEnv(env), { workspaceId: ws.id, now: NOW })),
    ).toEqual({
      deleted: true,
    });
    expect(await actorOn(db().global, admin.id, ws.id)).toBeNull();
    const [artifact] = await db()
      .select({ state: schema.artifacts.state })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    expect(artifact?.state).toBe("purging");
    expect(
      await db()
        .select()
        .from(schema.workspaceInvitations)
        .where(eq(schema.workspaceInvitations.workspaceId, ws.id)),
    ).toEqual([]);
    // A retry changes nothing; an unknown workspace is not found.
    expect(
      value(await deleteWorkspace(regionsFromEnv(env), { workspaceId: ws.id, now: NOW })),
    ).toEqual({
      deleted: false,
    });
    expect(
      await deleteWorkspace(regionsFromEnv(env), { workspaceId: "ws_missing", now: NOW }),
    ).toEqual({
      ok: false,
      code: "not_found",
      message: "Workspace not found.",
    });
    // While it is pending, the restore export keeps it.
    expect(await exportTombstones(regionsFromEnv(env))).toContainEqual({
      kind: "workspace",
      id: ws.id,
      deletedAt: NOW,
    });

    await drain(NOW + 1);
    expect(await advanceWorkspaceDeletion(regionsFromEnv(env), ws.id, NOW + 1)).toBe("absent");
    expect(await env.ARTIFACTS.head(key)).toBeNull();
    const [tombstone] = await db()
      .select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, ws.id));
    expect(tombstone).toMatchObject({ kind: "workspace" });
    for (const table of [schema.accountUsage, schema.annotationUsage, schema.ownerPlans]) {
      expect(await db().select().from(table).where(eq(table.ownerId, ws.id))).toEqual([]);
    }
    expect(
      await db()
        .select()
        .from(schema.workspaceDeletions)
        .where(eq(schema.workspaceDeletions.workspaceId, ws.id)),
    ).toEqual([]);
  });

  it("is advanced by the scheduled scan too", async () => {
    const { ws } = await newWorkspace();
    value(await deleteWorkspace(regionsFromEnv(env), { workspaceId: ws.id, now: NOW }));
    const pending = await db().select().from(schema.workspaceDeletions);
    const result = await processWorkspaceDeletions(regionsFromEnv(env), NOW + 1, 50);
    expect(result).toEqual({ processed: pending.length, finished: pending.length });
    expect(await advanceWorkspaceDeletion(regionsFromEnv(env), ws.id, NOW + 1)).toBe("absent");
  });

  it("is applied again after a restore brings the workspace back", async () => {
    const { ws, admin } = await newWorkspace();
    const { artifactId } = await publishInto(admin.id, ws.id);
    value(await deleteWorkspace(regionsFromEnv(env), { workspaceId: ws.id, now: NOW }));
    await drain(NOW + 1);
    const markers = await exportTombstones(regionsFromEnv(env));
    expect(markers).toContainEqual({ kind: "workspace", id: ws.id, deletedAt: NOW + 1 });

    // A restore to before the deletion: the workspace, its admin and its artifact are back, and
    // the tombstone is gone.
    await db()
      .delete(schema.tombstones)
      .where(inArray(schema.tombstones.id, [ws.id, artifactId]));
    await db()
      .insert(schema.workspaces)
      .values({ id: ws.id, slug: ws.slug, name: "Doomed", createdBy: admin.id, updatedAt: NOW });
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: ws.id, userId: admin.id, role: "admin", updatedAt: NOW });
    await db()
      .insert(schema.artifacts)
      .values({ id: artifactId, ownerId: ws.id, type: "site", name: "Plan", state: "archived" });

    const applied = await applyTombstones(
      db(),
      markers.filter((m) => m.id === ws.id || m.id === artifactId),
      NOW + 2,
    );
    expect(applied).toMatchObject({ workspaces: 1, artifacts: 1 });
    expect(await actorOn(db().global, admin.id, ws.id)).toBeNull();
    const [artifact] = await db()
      .select({ state: schema.artifacts.state })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    expect(artifact?.state).toBe("purging");
    await drain(NOW + 3);
    expect(await advanceWorkspaceDeletion(regionsFromEnv(env), ws.id, NOW + 3)).toBe("absent");
    // Running it again changes nothing.
    expect(await applyTombstones(db(), [], NOW + 4)).toMatchObject({ workspaces: 0, artifacts: 0 });
  });

  it("releases the workspace's custom domains and claims", async () => {
    const { ws, admin } = await newWorkspace();
    const { artifactId } = await publishInto(admin.id, ws.id);
    const hostname = `ws-${crypto.randomUUID().slice(0, 6)}.example.test`;
    await db().insert(schema.customDomains).values({
      hostname,
      ownerId: ws.id,
      artifactId,
      region: "default",
      state: "active",
      token: "domain-token",
      verifiedAt: NOW,
      checkedAt: NOW,
    });
    await db()
      .insert(schema.domainClaims)
      .values({
        hostname: `claim-${hostname}`,
        ownerId: ws.id,
        artifactId,
        region: "default",
        token: "claim-token",
        expiresAt: NOW + DAY,
      });
    value(await deleteWorkspace(regionsFromEnv(env), { workspaceId: ws.id, now: NOW }));
    await advanceWorkspaceDeletion(regionsFromEnv(env), ws.id, NOW + 1);
    const [domain] = await db()
      .select({ state: schema.customDomains.state })
      .from(schema.customDomains)
      .where(eq(schema.customDomains.hostname, hostname));
    expect(domain?.state ?? "gone").not.toBe("active");
    expect(
      await db().select().from(schema.domainClaims).where(eq(schema.domainClaims.ownerId, ws.id)),
    ).toEqual([]);
  });
  it("erases the workspace's brand with it", async () => {
    const { ws } = await newWorkspace();
    // No foreign key ties a brand to its owner (an owner may be a workspace), so nothing cascades.
    await db().insert(schema.ownerBrands).values({ ownerId: ws.id, name: "Acme", updatedAt: NOW });
    value(await deleteWorkspace(regionsFromEnv(env), { workspaceId: ws.id, now: NOW }));
    for (let i = 0; i < 5; i += 1) {
      if ((await advanceWorkspaceDeletion(regionsFromEnv(env), ws.id, NOW + 1)) !== "pending")
        break;
    }
    expect(
      await db().select().from(schema.ownerBrands).where(eq(schema.ownerBrands.ownerId, ws.id)),
    ).toEqual([]);
  });
  it("deletes the workspace's webhooks at once, with what they hold", async () => {
    const { ws } = await newWorkspace();
    const webhookId = `wh_${crypto.randomUUID().replaceAll("-", "")}`;
    // No foreign key ties a webhook to its owner (an owner may be a workspace).
    await db().insert(schema.webhooks).values({
      id: webhookId,
      ownerId: ws.id,
      host: "hooks.example.com",
      format: "generic",
      events: 1,
      keyId: "k1",
      urlBox: "sealed",
      secretBox: "sealed",
      createdVia: "session",
    });
    value(await deleteWorkspace(regionsFromEnv(env), { workspaceId: ws.id, now: NOW }));
    // Before any job runs: a deleted workspace's destination must not receive another event.
    expect(
      await db().select().from(schema.webhooks).where(eq(schema.webhooks.ownerId, ws.id)),
    ).toEqual([]);
  });
  it("removes again, after a restore, the webhooks of a workspace deleted before it", async () => {
    const { ws } = await newWorkspace();
    value(await deleteWorkspace(regionsFromEnv(env), { workspaceId: ws.id, now: NOW }));
    for (let i = 0; i < 5; i += 1) {
      if ((await advanceWorkspaceDeletion(regionsFromEnv(env), ws.id, NOW + 1)) !== "pending")
        break;
    }
    const markers = await exportTombstones(regionsFromEnv(env));
    expect(markers).toContainEqual({ kind: "workspace", id: ws.id, deletedAt: NOW + 1 });
    // The restore brought back only a webhook of the deleted workspace.
    const webhookId = `wh_${crypto.randomUUID().replaceAll("-", "")}`;
    await db().insert(schema.webhooks).values({
      id: webhookId,
      ownerId: ws.id,
      host: "hooks.example.com",
      format: "generic",
      events: 1,
      keyId: "k1",
      urlBox: "sealed",
      createdVia: "session",
    });
    await applyTombstones(db(), markers, NOW + DAY);
    expect(
      await db().select().from(schema.webhooks).where(eq(schema.webhooks.id, webhookId)),
    ).toEqual([]);
  });
});
