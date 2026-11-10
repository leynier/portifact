// Moving an artifact between spaces (premium plan T1): roles on both sides, quotas, objects shared
// with other artifacts of the source, comments, retries, an open upload and the refusal when the
// target has no room.
import { env } from "cloudflare:test";
import type { AnnotationTarget, JobMessage } from "@portifact/contracts";
import { type AccessDb, accessSchema, regionsFromEnv, schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getAccessLog } from "../src/access-log.ts";
import { createAnnotationThread, type HumanCheck } from "../src/annotations.ts";
import { getArtifact } from "../src/artifacts.ts";
import { deleteArtifact } from "../src/lifecycle.ts";
import { runJob } from "../src/outbox.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { readVersionFile } from "../src/read-file.ts";
import { transferArtifact } from "../src/transfer.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { DAY, db, grantPlan, NOW, sha256, user, value } from "./fixtures.ts";

const HUMAN: HumanCheck = { token: "solved", verify: async () => "passed" };
const DOC: AnnotationTarget = { schema: 1, path: "index.html", anchor: { kind: "document" } };
type User = { id: string; email: string };

async function workspace(admin: User, others: [User, "admin" | "editor" | "member"][] = []) {
  const slug = `x-${crypto.randomUUID().slice(0, 8)}`;
  const created = value(
    await createWorkspace(db().global, {
      slug,
      name: `WS ${slug}`,
      adminUserId: admin.id,
      now: NOW,
    }),
  );
  for (const [who, role] of others) {
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: created.id, userId: who.id, role, updatedAt: NOW });
  }
  await grantPlan(created.id, "team", { seats: 10 });
  return created;
}

/** Publishes `bodies` (index.html first) as `userId` into `ownerId`. */
async function publish(userId: string, ownerId: string, bodies: Record<string, string>) {
  const files = await Promise.all(
    Object.entries(bodies).map(async ([path, body]) => ({
      path,
      kind: "published" as const,
      sha256: await sha256(body),
      size: body.length,
      contentType: "text/html",
    })),
  );
  const prepared = value(
    await preparePublish(db(), {
      userId,
      targetOwnerId: ownerId,
      type: "site",
      name: "Plan",
      entrypoint: "index.html",
      baseVersionId: null,
      files,
      now: NOW,
    }),
  );
  for (const body of Object.values(bodies)) {
    await env.ARTIFACTS.put(`objects/${ownerId}/${await sha256(body)}`, body);
  }
  const committed = value(
    await commitPublish(db(), env.ARTIFACTS, { userId, sessionId: prepared.sessionId, now: NOW }),
  );
  return committed.artifactId;
}

async function usage(ownerId: string) {
  const [row] = await db()
    .select({
      active: schema.accountUsage.activeArtifacts,
      stored: schema.accountUsage.storedBytes,
    })
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, ownerId));
  return row ?? { active: 0, stored: 0 };
}

async function objectRows(ownerId: string) {
  return db()
    .select({ sha256: schema.objects.sha256, r2Key: schema.objects.r2Key })
    .from(schema.objects)
    .where(eq(schema.objects.ownerId, ownerId))
    .orderBy(schema.objects.sha256);
}

const move = (userId: string, artifactId: string, slug: string | null) =>
  transferArtifact(db(), env.ARTIFACTS, { userId, artifactId, workspace: slug, now: NOW });

describe("transferring an artifact", () => {
  it("moves it with its slot, storage and files to a workspace, keeping its ID and content", async () => {
    const alice = await user();
    const ws = await workspace(alice);
    const body = `<p>${crypto.randomUUID()}</p>`;
    const id = await publish(alice.id, alice.id, { "index.html": body });
    const key = `objects/${alice.id}/${await sha256(body)}`;

    const moved = value(await move(alice.id, id, ws.slug));
    expect(moved).toMatchObject({ id, ownerId: ws.id, state: "active" });
    expect(await usage(alice.id)).toEqual({ active: 0, stored: 0 });
    expect(await usage(ws.id)).toEqual({ active: 1, stored: body.length });
    // No bytes were copied: the workspace's row points at the key the bytes were stored under,
    // the source's row is released, and the bytes stay because a row still has the key.
    expect(await objectRows(ws.id)).toEqual([{ sha256: await sha256(body), r2Key: key }]);
    expect(await objectRows(alice.id)).toEqual([]);
    expect(await env.ARTIFACTS.head(key)).not.toBeNull();
    const page = value(
      await readVersionFile(db(), env.ARTIFACTS, {
        userId: alice.id,
        artifactId: id,
        versionId: moved.currentVersionId as string,
        kind: "published",
        offset: 0,
        now: NOW,
      }),
    );
    expect(page).toMatchObject({ content: body });
    const [event] = await db()
      .select()
      .from(schema.lifecycleEvents)
      .where(
        and(
          eq(schema.lifecycleEvents.artifactId, id),
          eq(schema.lifecycleEvents.event, "transferred"),
        ),
      );
    expect(event).toMatchObject({ actorId: alice.id, details: { from: alice.id, to: ws.id } });
  });

  it("keeps objects the source's other artifacts still use, and counts them in both", async () => {
    const alice = await user();
    const ws = await workspace(alice);
    const shared = `<p>${crypto.randomUUID()}</p>`;
    const own = `<p>${crypto.randomUUID()}</p>`;
    const stays = await publish(alice.id, alice.id, { "index.html": shared });
    const goes = await publish(alice.id, alice.id, { "index.html": shared, "a.html": own });
    expect((await usage(alice.id)).stored).toBe(shared.length + own.length);

    value(await move(alice.id, goes, ws.slug));
    expect((await usage(alice.id)).stored).toBe(shared.length);
    expect((await usage(ws.id)).stored).toBe(shared.length + own.length);
    expect((await objectRows(alice.id)).map((row) => row.sha256)).toEqual([await sha256(shared)]);
    expect(await objectRows(ws.id)).toHaveLength(2);

    // Deleting the artifact that stayed releases the source's row, but the bytes stay for the
    // workspace's row with the same key.
    value(
      await deleteArtifact(db(), env.ARTIFACTS, { userId: alice.id, artifactId: stays, now: NOW }),
    );
    expect(await objectRows(alice.id)).toEqual([]);
    expect(await env.ARTIFACTS.head(`objects/${alice.id}/${await sha256(shared)}`)).not.toBeNull();
  });

  it("dedupes against objects the target already stores", async () => {
    const alice = await user();
    const ws = await workspace(alice);
    const body = `<p>${crypto.randomUUID()}</p>`;
    await publish(alice.id, ws.id, { "index.html": body });
    const id = await publish(alice.id, alice.id, { "index.html": body });
    value(await move(alice.id, id, ws.slug));
    expect((await usage(ws.id)).stored).toBe(body.length);
    expect(await objectRows(ws.id)).toEqual([
      { sha256: await sha256(body), r2Key: `objects/${ws.id}/${await sha256(body)}` },
    ]);
    expect(await objectRows(alice.id)).toEqual([]);
  });

  it("moves its comments and their usage", async () => {
    const alice = await user();
    const ws = await workspace(alice);
    const id = await publish(alice.id, alice.id, { "index.html": "<p>c</p>" });
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, id));
    const [artifact] = await db()
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, id));
    value(
      await createAnnotationThread(db(), {
        userId: alice.id,
        artifactId: id,
        versionId: artifact?.currentVersionId as string,
        target: DOC,
        body: "Looks good",
        humanCheck: HUMAN,
        now: NOW,
      } as never),
    );
    value(await move(alice.id, id, ws.slug));
    const messages = await db()
      .select({ ownerId: schema.annotationMessages.ownerId })
      .from(schema.annotationMessages)
      .where(eq(schema.annotationMessages.artifactId, id));
    expect(messages).toEqual([{ ownerId: ws.id }]);
    const [counts] = await db()
      .select({ messages: schema.annotationUsage.messages })
      .from(schema.annotationUsage)
      .where(eq(schema.annotationUsage.ownerId, ws.id));
    expect(counts?.messages).toBe(1);
  });

  it("needs an admin or editor of the target, and an admin of a source workspace", async () => {
    const [alice, bob, outsider] = [await user(), await user(), await user()];
    const source = await workspace(alice, [[bob, "member"]]);
    const target = await workspace(alice, [[bob, "editor"]]);
    const id = await publish(alice.id, source.id, { "index.html": "<p>m</p>" });
    expect(await move(bob.id, id, target.slug)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await move(outsider.id, id, target.slug)).toEqual({
      ok: false,
      code: "not_found",
      message: "Artifact not found.",
    });
    const other = await workspace(alice, [[bob, "member"]]);
    expect(await move(alice.id, id, other.slug)).toMatchObject({ ok: true });
    const back = await move(bob.id, id, source.slug);
    expect(back).toMatchObject({ ok: false });
    expect(await move(alice.id, id, "no-such-space")).toEqual({
      ok: false,
      code: "not_found",
      message: "Workspace not found.",
    });
    const mine = await publish(bob.id, bob.id, { "index.html": "<p>b</p>" });
    expect(await move(bob.id, mine, source.slug)).toMatchObject({ ok: false, code: "forbidden" });
    expect(value(await move(bob.id, mine, target.slug)).ownerId).toBe(target.id);
    // Once in the workspace, only its admin takes it out again.
    expect(await move(bob.id, mine, null)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("takes an admin to move an artifact out of a workspace; an editor cannot", async () => {
    const [alice, eddie] = [await user(), await user()];
    const team = await workspace(alice, [[eddie, "editor"]]);
    const id = await publish(eddie.id, team.id, { "index.html": "<p>team asset</p>" });
    expect(await move(eddie.id, id, null)).toEqual({
      ok: false,
      code: "forbidden",
      message: "Your role on this workspace does not allow this.",
    });
    const other = await workspace(alice, [[eddie, "admin"]]);
    expect(await move(eddie.id, id, other.slug)).toMatchObject({ ok: false, code: "forbidden" });
    expect(value(await move(alice.id, id, null)).ownerId).toBe(alice.id);
  });

  it("holds the current version to the target plan's per-artifact size, like a publish there", async () => {
    const alice = await user();
    const ws = await workspace(alice);
    await db()
      .update(schema.ownerPlans)
      .set({ overrides: { limits: { artifactBytes: 10 } } })
      .where(eq(schema.ownerPlans.ownerId, ws.id));
    const big = await publish(alice.id, alice.id, { "index.html": "<p>eleven bytes or more</p>" });
    expect(await move(alice.id, big, ws.slug)).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "An artifact version can be at most 10 bytes.",
    });
    const small = await publish(alice.id, alice.id, { "index.html": "<p>tiny</p>" });
    expect(await move(alice.id, small, ws.slug)).toMatchObject({ ok: false });
    // Exactly at the limit it fits.
    const fits = await publish(alice.id, alice.id, { "index.html": "<p>abc</p>" });
    expect(value(await move(alice.id, fits, ws.slug)).ownerId).toBe(ws.id);
  });

  it("refuses a target without room and changes nothing", async () => {
    const alice = await user();
    const ws = await workspace(alice);
    await db()
      .update(schema.ownerPlans)
      .set({ plan: "free", seats: 1 })
      .where(eq(schema.ownerPlans.ownerId, ws.id));
    await db()
      .insert(schema.accountUsage)
      .values({ ownerId: ws.id, monthStartedAt: NOW, activeArtifacts: 50, activeLimit: 50 })
      .onConflictDoUpdate({
        target: schema.accountUsage.ownerId,
        set: { activeArtifacts: 50, activeLimit: 50 },
      });
    const id = await publish(alice.id, alice.id, { "index.html": "<p>full</p>" });
    expect(await move(alice.id, id, ws.slug)).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(value(await getArtifact(db(), { userId: alice.id, artifactId: id })).ownerId).toBe(
      alice.id,
    );
    expect((await usage(alice.id)).active).toBe(1);
  });

  it("holds the target to its plan even when its limit columns are still higher", async () => {
    const alice = await user();
    const ws = await workspace(alice);
    // A lowered plan: free allows 50 active artifacts and 2.5 GB, the columns still allow more.
    await db()
      .update(schema.ownerPlans)
      .set({ plan: "free", seats: 1 })
      .where(eq(schema.ownerPlans.ownerId, ws.id));
    const setUsage = (active: number, stored: number) =>
      db()
        .insert(schema.accountUsage)
        .values({
          ownerId: ws.id,
          monthStartedAt: NOW,
          activeArtifacts: active,
          storedBytes: stored,
          activeLimit: 1_000,
          bytesLimit: 100_000_000_000,
        })
        .onConflictDoUpdate({
          target: schema.accountUsage.ownerId,
          set: { activeArtifacts: active, storedBytes: stored },
        });
    const body = "<p>plan</p>";
    const id = await publish(alice.id, alice.id, { "index.html": body });
    await setUsage(50, 0);
    expect(await move(alice.id, id, ws.slug)).toMatchObject({ ok: false, code: "quota_exceeded" });
    await setUsage(0, 2_500_000_000 - body.length + 1);
    expect(await move(alice.id, id, ws.slug)).toMatchObject({ ok: false, code: "quota_exceeded" });
    // Exactly at the limits it fits.
    await setUsage(49, 2_500_000_000 - body.length);
    expect(value(await move(alice.id, id, ws.slug)).ownerId).toBe(ws.id);
    expect(await usage(ws.id)).toEqual({ active: 50, stored: 2_500_000_000 });
  });

  it("moves an archived artifact into a target whose slots are full", async () => {
    const alice = await user();
    const ws = await workspace(alice);
    await db()
      .update(schema.ownerPlans)
      .set({ plan: "free", seats: 1 })
      .where(eq(schema.ownerPlans.ownerId, ws.id));
    await db()
      .insert(schema.accountUsage)
      .values({ ownerId: ws.id, monthStartedAt: NOW, activeArtifacts: 50 })
      .onConflictDoUpdate({ target: schema.accountUsage.ownerId, set: { activeArtifacts: 50 } });
    const id = await publish(alice.id, alice.id, { "index.html": "<p>old</p>" });
    await db()
      .update(schema.artifacts)
      .set({ state: "archived" })
      .where(eq(schema.artifacts.id, id));
    await db()
      .update(schema.accountUsage)
      .set({ activeArtifacts: 0 })
      .where(eq(schema.accountUsage.ownerId, alice.id));
    expect(value(await move(alice.id, id, ws.slug)).state).toBe("archived");
    expect((await usage(ws.id)).active).toBe(50);
  });

  it("is refused by the database when a race filled the target past the check", async () => {
    const alice = await user();
    const ws = await workspace(alice);
    // The plan allows it, but the limit column (what a concurrent change left) does not.
    await db()
      .insert(schema.accountUsage)
      .values({ ownerId: ws.id, monthStartedAt: NOW, activeArtifacts: 0, activeLimit: 0 })
      .onConflictDoUpdate({ target: schema.accountUsage.ownerId, set: { activeLimit: 0 } });
    const id = await publish(alice.id, alice.id, { "index.html": "<p>race</p>" });
    expect(await move(alice.id, id, ws.slug)).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(value(await getArtifact(db(), { userId: alice.id, artifactId: id })).ownerId).toBe(
      alice.id,
    );
    expect(await objectRows(ws.id)).toEqual([]);
  });

  it("answers a retry with the artifact where it is, counting nothing twice", async () => {
    const alice = await user();
    const ws = await workspace(alice);
    const id = await publish(alice.id, alice.id, { "index.html": "<p>again</p>" });
    value(await move(alice.id, id, ws.slug));
    const once = await usage(ws.id);
    expect(value(await move(alice.id, id, ws.slug)).ownerId).toBe(ws.id);
    expect(await usage(ws.id)).toEqual(once);
  });

  it("waits for an open upload to the artifact", async () => {
    const alice = await user();
    const ws = await workspace(alice);
    const id = await publish(alice.id, alice.id, { "index.html": "<p>v1</p>" });
    const [artifact] = await db()
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, id));
    const body = "<p>v2</p>";
    value(
      await preparePublish(db(), {
        userId: alice.id,
        artifactId: id,
        type: "site",
        name: "Plan",
        entrypoint: "index.html",
        baseVersionId: artifact?.currentVersionId ?? null,
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
    expect(await move(alice.id, id, ws.slug)).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
  });

  it("refuses an artifact that is not active or archived", async () => {
    const alice = await user();
    const ws = await workspace(alice);
    const id = await publish(alice.id, alice.id, { "index.html": "<p>s</p>" });
    await db()
      .update(schema.artifacts)
      .set({ state: "suspended" })
      .where(eq(schema.artifacts.id, id));
    expect(await move(alice.id, id, ws.slug)).toMatchObject({
      ok: false,
      code: "artifact_archived",
    });
  });

  it("leaves no stored rendering without a row when the moved document is published again", async () => {
    const alice = await user();
    const ws = await workspace(alice);
    const source = `# Report ${crypto.randomUUID()}\n\nBody.`;
    const publishDoc = async (ownerId: string) => {
      const sha = await sha256(source);
      const prepared = value(
        await preparePublish(db(), {
          userId: alice.id,
          targetOwnerId: ownerId,
          type: "markdown",
          name: "Report",
          entrypoint: "report.md",
          baseVersionId: null,
          files: [
            {
              path: "report.md",
              kind: "published",
              sha256: sha,
              size: new TextEncoder().encode(source).byteLength,
              contentType: "text/markdown; charset=utf-8",
            },
          ],
          now: NOW,
        }),
      );
      for (const upload of prepared.uploads) await env.ARTIFACTS.put(upload.r2Key, source);
      return value(
        await commitPublish(db(), env.ARTIFACTS, {
          userId: alice.id,
          sessionId: prepared.sessionId,
          now: NOW,
        }),
      ).artifactId;
    };
    const id = await publishDoc(alice.id);
    value(await move(alice.id, id, ws.slug));
    await publishDoc(ws.id);
    const listed = await env.ARTIFACTS.list({ prefix: `objects/${ws.id}/` });
    const keys = new Set((await objectRows(ws.id)).map((row) => row.r2Key));
    expect(listed.objects.map((o) => o.key).filter((key) => !keys.has(key))).toEqual([]);
  });

  it("moves the access history with the artifact, kept by the target's plan", async () => {
    const alice = await user();
    const ws = await workspace(alice);
    const id = await publish(alice.id, alice.id, { "index.html": "<p>watched</p>" });
    const access = regionsFromEnv(env).get("default").accessDb as AccessDb;
    const opened = NOW - DAY;
    await access.insert(accessSchema.accessEvents).values({
      artifactId: id,
      windowStart: opened,
      userId: "u_visitor",
      ownerId: alice.id,
      email: "visitor@example.test",
      openedAt: opened,
      expiresAt: opened + 30 * DAY,
    });
    await access.insert(accessSchema.artifactViews).values({
      artifactId: id,
      day: opened,
      ownerId: alice.id,
      views: 3,
      signedInViews: 1,
      expiresAt: opened + DAY + 30 * DAY,
    });
    value(await move(alice.id, id, ws.slug));
    const jobs = await db()
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.topic, "access_history_move"), eq(schema.outbox.subject, id)));
    expect(jobs).toHaveLength(1);
    const job = jobs[0] as typeof schema.outbox.$inferSelect;
    const run = () =>
      runJob(db(), env.ARTIFACTS, { id: job.id, topic: job.topic } as JobMessage, NOW, { access });
    expect(await run()).toBe("done");
    const [event] = await access
      .select()
      .from(accessSchema.accessEvents)
      .where(eq(accessSchema.accessEvents.artifactId, id));
    expect(event).toMatchObject({ ownerId: ws.id, expiresAt: opened + 365 * DAY });
    const [view] = await access
      .select()
      .from(accessSchema.artifactViews)
      .where(eq(accessSchema.artifactViews.artifactId, id));
    expect(view).toMatchObject({ ownerId: ws.id, expiresAt: opened + DAY + 365 * DAY });
    const log = value(
      await getAccessLog(db(), access, {
        userId: alice.id,
        artifactId: id,
        limit: 10,
        now: NOW,
      } as never),
    );
    expect(JSON.stringify(log)).toContain("visitor@example.test");
    // Running it again changes nothing.
    expect(await run()).toBe("done");
  });
});
