// The workspace_members_invitations migration: invitations, workspace deletions, the last-admin triggers, the triggers that move
// usage with a transferred artifact, and object rows that share an R2 key.
import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, schema } from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 10);
const db = () => createDb(env.DB);

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

const hex = () => crypto.randomUUID().replaceAll("-", "");

async function workspace(): Promise<string> {
  const id = `ws_${hex()}`;
  await db()
    .insert(schema.workspaces)
    .values({
      id,
      slug: `s-${hex().slice(0, 12)}`,
      name: "Team",
      createdBy: "u_x",
      updatedAt: NOW,
    });
  return id;
}

async function user(): Promise<string> {
  const id = `u_${hex()}`;
  await db()
    .insert(schema.users)
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
  return id;
}

async function member(workspaceId: string, userId: string, role: "admin" | "editor" | "member") {
  await db().insert(schema.workspaceMembers).values({ workspaceId, userId, role, updatedAt: NOW });
}

const roleOf = async (workspaceId: string, userId: string) =>
  (
    await db()
      .select({ role: schema.workspaceMembers.role })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, workspaceId),
          eq(schema.workspaceMembers.userId, userId),
        ),
      )
  )[0]?.role;

describe("workspace members migration: a workspace keeps an admin", () => {
  it("refuses demoting or removing the last admin, and allows it while another remains", async () => {
    const ws = await workspace();
    const [a, b] = [await user(), await user()];
    await member(ws, a, "admin");
    const demote = (userId: string) =>
      db()
        .update(schema.workspaceMembers)
        .set({ role: "editor" })
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, ws),
            eq(schema.workspaceMembers.userId, userId),
          ),
        );
    const remove = (userId: string) =>
      db()
        .delete(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, ws),
            eq(schema.workspaceMembers.userId, userId),
          ),
        );
    await rejects(demote(a), /sole_workspace_admin/);
    await rejects(remove(a), /sole_workspace_admin/);
    await member(ws, b, "admin");
    await demote(a);
    expect(await roleOf(ws, a)).toBe("editor");
    await rejects(demote(b), /sole_workspace_admin/);
    await remove(a);
    expect(await roleOf(ws, a)).toBeUndefined();
    await rejects(remove(b), /sole_workspace_admin/);
  });

  it("of two concurrent demotions of two admins lets exactly one through", async () => {
    const ws = await workspace();
    const [a, b] = [await user(), await user()];
    await member(ws, a, "admin");
    await member(ws, b, "admin");
    const demote = (userId: string) =>
      db()
        .update(schema.workspaceMembers)
        .set({ role: "member" })
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, ws),
            eq(schema.workspaceMembers.userId, userId),
          ),
        );
    const results = await Promise.allSettled([demote(a), demote(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const roles = [await roleOf(ws, a), await roleOf(ws, b)].sort();
    expect(roles).toEqual(["admin", "member"]);
  });

  it("lets the memberships go with a recorded workspace deletion or a tombstoned account", async () => {
    const ws = await workspace();
    const sole = await user();
    await member(ws, sole, "admin");
    await rejects(
      db().delete(schema.workspaces).where(eq(schema.workspaces.id, ws)),
      /sole_workspace_admin/,
    );
    await db().insert(schema.workspaceDeletions).values({ workspaceId: ws, requestedAt: NOW });
    await db().delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    expect(await roleOf(ws, sole)).toBeUndefined();

    const other = await workspace();
    const gone = await user();
    await member(other, gone, "admin");
    await db().insert(schema.tombstones).values({ kind: "account", id: gone, deletedAt: NOW });
    await db().delete(schema.users).where(eq(schema.users.id, gone));
    expect(await roleOf(other, gone)).toBeUndefined();
  });
});

describe("workspace members migration: invitations", () => {
  it("keeps one invitation per workspace and address, unique tokens, and goes with the workspace", async () => {
    const ws = await workspace();
    const admin = await user();
    await member(ws, admin, "admin");
    const invitation = (id: string, email: string, tokenHash: string) =>
      db()
        .insert(schema.workspaceInvitations)
        .values({
          id,
          workspaceId: ws,
          email,
          role: "member",
          tokenHash,
          invitedBy: admin,
          createdAt: NOW,
          expiresAt: NOW + 1,
        });
    await invitation(`inv_${hex()}`, "a@example.test", "h1");
    await rejects(invitation(`inv_${hex()}`, "a@example.test", "h2"), /UNIQUE/);
    await rejects(invitation(`inv_${hex()}`, "b@example.test", "h1"), /UNIQUE/);
    await rejects(
      db()
        .insert(schema.workspaceInvitations)
        .values({
          id: `inv_${hex()}`,
          workspaceId: ws,
          email: "c@example.test",
          role: "owner" as "member",
          tokenHash: "h3",
          createdAt: NOW,
          expiresAt: NOW,
        }),
      /CHECK/,
    );
    await db().insert(schema.workspaceDeletions).values({ workspaceId: ws, requestedAt: NOW });
    await db().delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    expect(
      await db()
        .select()
        .from(schema.workspaceInvitations)
        .where(eq(schema.workspaceInvitations.workspaceId, ws)),
    ).toEqual([]);
  });

  it("keeps an invitation when the admin who sent it is deleted", async () => {
    const ws = await workspace();
    const [admin, other] = [await user(), await user()];
    await member(ws, admin, "admin");
    await member(ws, other, "admin");
    const id = `inv_${hex()}`;
    await db()
      .insert(schema.workspaceInvitations)
      .values({
        id,
        workspaceId: ws,
        email: "d@example.test",
        role: "editor",
        tokenHash: `h-${id}`,
        invitedBy: admin,
        createdAt: NOW,
        expiresAt: NOW + 1,
      });
    await db().delete(schema.users).where(eq(schema.users.id, admin));
    const [row] = await db()
      .select({ invitedBy: schema.workspaceInvitations.invitedBy })
      .from(schema.workspaceInvitations)
      .where(eq(schema.workspaceInvitations.id, id));
    expect(row).toEqual({ invitedBy: null });
  });
});

describe("workspace members migration: transfers", () => {
  const usageOf = async (ownerId: string) =>
    (
      await db()
        .select({ active: schema.accountUsage.activeArtifacts })
        .from(schema.accountUsage)
        .where(eq(schema.accountUsage.ownerId, ownerId))
    )[0]?.active;
  const annotationsOf = async (ownerId: string) => {
    const [row] = await db()
      .select({ messages: schema.annotationUsage.messages, bytes: schema.annotationUsage.bytes })
      .from(schema.annotationUsage)
      .where(eq(schema.annotationUsage.ownerId, ownerId));
    return row;
  };

  async function artifact(ownerId: string, state: "active" | "archived") {
    const id = hex()
      .slice(0, 10)
      .replace(/[0189]/g, "a");
    await db()
      .insert(schema.accountUsage)
      .values({ ownerId, monthStartedAt: NOW, activeArtifacts: state === "active" ? 1 : 0 })
      .onConflictDoNothing();
    await db().insert(schema.artifacts).values({ id, ownerId, type: "site", name: "A", state });
    return id;
  }

  const move = (id: string, ownerId: string) =>
    db().update(schema.artifacts).set({ ownerId }).where(eq(schema.artifacts.id, id));

  it("moves an active artifact's slot to the new owner, creating its usage row", async () => {
    const [from, to] = [`u_${hex()}`, `ws_${hex()}`];
    const id = await artifact(from, "active");
    await move(id, to);
    expect(await usageOf(from)).toBe(0);
    expect(await usageOf(to)).toBe(1);
  });

  it("moves no slot for an archived artifact", async () => {
    const [from, to] = [`u_${hex()}`, `ws_${hex()}`];
    const id = await artifact(from, "archived");
    await move(id, to);
    expect(await usageOf(from)).toBe(0);
    expect(await usageOf(to)).toBeUndefined();
  });

  it("refuses a move into an owner without a free slot", async () => {
    const [from, to] = [`u_${hex()}`, `ws_${hex()}`];
    const id = await artifact(from, "active");
    await db()
      .insert(schema.accountUsage)
      .values({ ownerId: to, monthStartedAt: NOW, activeArtifacts: 1, activeLimit: 1 });
    await rejects(move(id, to), /CHECK/);
    expect(await usageOf(from)).toBe(1);
  });

  it("moves comments' usage with their owner, within the target's limits", async () => {
    const [from, to] = [`u_${hex()}`, `ws_${hex()}`];
    const id = await artifact(from, "archived");
    const threadId = `t_${hex()}`;
    await db().insert(schema.annotationThreads).values({
      id: threadId,
      artifactId: id,
      versionId: "v1",
      ownerId: from,
      authorId: "u_author",
      target: "{}",
      targetBytes: 40,
      path: "index.html",
      updatedAt: NOW,
    });
    for (const [messageId, state] of [
      [`m_${hex()}`, "visible"],
      [`m_${hex()}`, "deleted"],
    ] as const) {
      await db()
        .insert(schema.annotationMessages)
        .values({
          id: messageId,
          threadId,
          artifactId: id,
          ownerId: from,
          authorId: "u_author",
          body: state === "deleted" ? null : "x".repeat(10),
          bodyBytes: state === "deleted" ? 0 : 10,
          state,
        });
    }
    expect(await annotationsOf(from)).toEqual({ messages: 1, bytes: 50 });
    await db()
      .update(schema.annotationThreads)
      .set({ ownerId: to })
      .where(eq(schema.annotationThreads.artifactId, id));
    await db()
      .update(schema.annotationMessages)
      .set({ ownerId: to })
      .where(eq(schema.annotationMessages.artifactId, id));
    expect(await annotationsOf(from)).toEqual({ messages: 0, bytes: 0 });
    expect(await annotationsOf(to)).toEqual({ messages: 1, bytes: 50 });

    const full = `ws_${hex()}`;
    await db()
      .insert(schema.annotationUsage)
      .values({ ownerId: full, messages: 0, bytes: 0, messagesLimit: 0 });
    await rejects(
      db()
        .update(schema.annotationMessages)
        .set({ ownerId: full })
        .where(eq(schema.annotationMessages.artifactId, id)),
      /CHECK/,
    );
    expect(await annotationsOf(to)).toEqual({ messages: 1, bytes: 50 });
  });

  it("lets two owners' object rows share one R2 key", async () => {
    const key = `objects/u_${hex()}/${"a".repeat(64)}`;
    for (const ownerId of [`u_${hex()}`, `ws_${hex()}`]) {
      await db()
        .insert(schema.objects)
        .values({ ownerId, sha256: "a".repeat(64), size: 3, r2Key: key, state: "verified" });
    }
    const rows = await db().select().from(schema.objects).where(eq(schema.objects.r2Key, key));
    expect(rows).toHaveLength(2);
  });
});
