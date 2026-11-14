// Who may write to an artifact's data from its page (decision 0026, delivery 9): the owner side's
// setting, its checks against the owner's plan and the workspace's policy, its audit event, the
// states and holds that refuse it, and the transfer that gives the decision back to the new owner.
import { env } from "cloudflare:test";
import { DEFAULT_POLICY, planRequiredMessage } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { DATA_WRITER_MESSAGES, HELD_MESSAGE } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDataWriters, setDataWriters, transferArtifact } from "../src/index.ts";
import { placeLegalHold } from "../src/legal-holds.ts";
import { db, grantPlan, NOW, publishSite, user, value } from "./fixtures.ts";

const ON = { enabled: true };

/** An artifact of `ownerId` (a workspace's: published by `userId`, then owned by it) with data. */
async function withData(ownerId: string, userId = ownerId) {
  const { artifactId } = await publishSite(userId);
  if (ownerId !== userId) {
    await db().update(schema.artifacts).set({ ownerId }).where(eq(schema.artifacts.id, artifactId));
  }
  await db().insert(schema.artifactData).values({ artifactId, updatedAt: NOW });
  return artifactId;
}

async function workspace(
  members: [string, "admin" | "editor" | "member"][],
  policy: unknown = null,
) {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  await db()
    .insert(schema.workspaces)
    .values({
      id,
      slug: id.slice(3, 23),
      name: "Team",
      createdBy: members[0]?.[0] ?? "x",
      policy,
      updatedAt: NOW,
    });
  for (const [userId, role] of members) {
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: id, userId, role, updatedAt: NOW });
  }
  return { id, slug: id.slice(3, 23) };
}

async function events(artifactId: string) {
  return db()
    .select({ detail: schema.auditEvents.detail, ownerId: schema.auditEvents.ownerId })
    .from(schema.auditEvents)
    .where(
      and(
        eq(schema.auditEvents.kind, "data.writers_changed"),
        eq(schema.auditEvents.artifactId, artifactId),
      ),
    );
}

const set = (userId: string, artifactId: string, writers: "signed_in" | "anyone", deps = ON) =>
  setDataWriters(db(), deps, { userId, artifactId, writers, now: NOW });

describe("who may write from the page", () => {
  it("lets a personal space open its data to anyone and back, recording each change once", async () => {
    const owner = await user("Owner");
    const id = await withData(owner.id);
    expect(
      value(await getDataWriters(db(), ON, { userId: owner.id, artifactId: id, now: NOW })),
    ).toEqual({ artifactId: id, writers: "signed_in", anonymous: "off" });
    expect(value(await set(owner.id, id, "anyone"))).toEqual({
      artifactId: id,
      writers: "anyone",
      anonymous: "available",
    });
    // The same value again changes nothing and records nothing.
    value(await set(owner.id, id, "anyone"));
    value(await set(owner.id, id, "signed_in"));
    const recorded = await events(id);
    expect(recorded.map((row) => row.detail)).toEqual([
      { writers: "anyone" },
      { writers: "signed_in" },
    ]);
    expect(recorded.every((row) => row.ownerId === owner.id)).toBe(true);
  });

  it("asks a workspace for policies in its plan, then for a policy that allows it", async () => {
    const admin = await user("Admin");
    const free = await workspace([[admin.id, "admin"]]);
    const onFree = await withData(free.id, admin.id);
    expect(await set(admin.id, onFree, "anyone")).toEqual({
      ok: false,
      code: "plan_required",
      message: planRequiredMessage("policies"),
    });
    // Narrowing is never refused for the plan or the policy.
    value(await set(admin.id, onFree, "signed_in"));

    const strict = await workspace([[admin.id, "admin"]]);
    await grantPlan(strict.id, "enterprise");
    const onStrict = await withData(strict.id, admin.id);
    expect(await set(admin.id, onStrict, "anyone")).toEqual({
      ok: false,
      code: "policy_refused",
      message: DATA_WRITER_MESSAGES.policy,
    });
    expect(await events(onStrict)).toEqual([]);

    const open = await workspace([[admin.id, "admin"]], {
      ...DEFAULT_POLICY,
      anonymousDataWriters: "allowed",
    });
    await grantPlan(open.id, "enterprise");
    const onOpen = await withData(open.id, admin.id);
    expect(value(await set(admin.id, onOpen, "anyone")).anonymous).toBe("available");
  });

  it("reports a choice the plan or policy no longer allows without dropping it", async () => {
    const admin = await user("Admin");
    const ws = await workspace([[admin.id, "admin"]], {
      ...DEFAULT_POLICY,
      anonymousDataWriters: "allowed",
    });
    await grantPlan(ws.id, "enterprise");
    const id = await withData(ws.id, admin.id);
    value(await set(admin.id, id, "anyone"));
    await db()
      .update(schema.workspaces)
      .set({ policy: null })
      .where(eq(schema.workspaces.id, ws.id));
    const input = { userId: admin.id, artifactId: id, now: NOW };
    expect(value(await getDataWriters(db(), ON, input))).toMatchObject({
      writers: "anyone",
      anonymous: "policy_refused",
    });
    await grantPlan(ws.id, "free");
    expect(value(await getDataWriters(db(), ON, input))).toMatchObject({
      writers: "anyone",
      anonymous: "plan_required",
    });
  });

  it("refuses a stranger like a missing artifact, a member as forbidden, and nothing while off", async () => {
    const admin = await user("Admin");
    const member = await user("Member");
    const stranger = await user("Stranger");
    const ws = await workspace([
      [admin.id, "admin"],
      [member.id, "member"],
    ]);
    const id = await withData(ws.id, admin.id);
    expect(await set(stranger.id, id, "signed_in")).toMatchObject({
      ok: false,
      code: "not_found",
      message: "Artifact not found.",
    });
    expect(await set(admin.id, "zzzzzzzzzz", "signed_in")).toMatchObject({ code: "not_found" });
    expect(await set(member.id, id, "signed_in")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await set(admin.id, id, "signed_in", { enabled: false })).toEqual({
      ok: false,
      code: "not_found",
      message: "Artifact data is not available.",
    });
    expect(
      await getDataWriters(
        db(),
        { enabled: false },
        { userId: admin.id, artifactId: id, now: NOW },
      ),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("answers an artifact without data, and refuses archived, suspended and held ones", async () => {
    const owner = await user("Owner");
    const { artifactId: empty } = await publishSite(owner.id);
    expect(await set(owner.id, empty, "anyone")).toMatchObject({ ok: false, code: "not_found" });

    const archived = await withData(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ state: "archived" })
      .where(eq(schema.artifacts.id, archived));
    expect(await set(owner.id, archived, "anyone")).toMatchObject({
      code: "artifact_archived",
    });
    // Reading still works on an archived artifact.
    value(await getDataWriters(db(), ON, { userId: owner.id, artifactId: archived, now: NOW }));

    const suspended = await withData(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ state: "suspended" })
      .where(eq(schema.artifacts.id, suspended));
    expect(await set(owner.id, suspended, "anyone")).toMatchObject({ code: "forbidden" });

    const held = await withData(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ state: "suspended" })
      .where(eq(schema.artifacts.id, held));
    value(
      await placeLegalHold(db(), { artifactId: held, ground: "case-9", releaseAt: null, now: NOW }),
    );
    expect(await set(owner.id, held, "anyone")).toEqual({
      ok: false,
      code: "forbidden",
      message: HELD_MESSAGE,
    });
  });

  it("goes back to signed-in writers when the artifact moves to another owner", async () => {
    const owner = await user("Owner");
    const id = await withData(owner.id);
    value(await set(owner.id, id, "anyone"));
    const target = await workspace([[owner.id, "admin"]]);
    await grantPlan(target.id, "enterprise");
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId: id,
        workspace: target.slug,
        now: NOW,
      }),
    );
    const [row] = await db()
      .select({ writers: schema.artifactData.writers })
      .from(schema.artifactData)
      .where(eq(schema.artifactData.artifactId, id));
    expect(row?.writers).toBe("signed_in");
  });
});
