import { env } from "cloudflare:test";
import { REVIEW_SESSION, type ReviewKind } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  endReviewSession,
  getViewerArtifact,
  hashSecret,
  issueReviewHandoff,
  pruneReviewSessions,
  redeemReviewHandoff,
  refreshReviewSession,
  reviewSessionTag,
} from "../src/index.ts";

const ID = "r7d2qm4xab";
const OTHER_ID = "r3n5wq7yzc";
const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
const HANDOFF_MS = REVIEW_SESSION.handoffTtlSeconds * 1000;
const SESSION_MS = REVIEW_SESSION.sessionTtlSeconds * 1000;
const TAB_SESSION_MS = REVIEW_SESSION.tabSessionTtlSeconds * 1000;
const db = () => regionsFromEnv(env).get("default").db;

const OWNER = "ru_owner";
const READER = "ru_reader";
const STRANGER = "ru_stranger";
const appSession = (userId: string) => `ras_${userId}`;

async function seed(overrides: Partial<typeof schema.artifacts.$inferInsert> = {}) {
  for (const table of [
    "review_sessions",
    "review_handoffs",
    "artifact_readers",
    "versions",
    "artifacts",
    "sessions",
    "users",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const at = new Date(NOW - 30 * DAY);
  await db()
    .insert(schema.users)
    .values(
      [
        { id: OWNER, name: "Owner", email: "owner@example.com" },
        { id: READER, name: "Reader", email: "reader@example.com" },
        { id: STRANGER, name: "Stranger", email: "stranger@example.com" },
      ].map((user) => ({ ...user, emailVerified: true, createdAt: at, updatedAt: at })),
    );
  await db()
    .insert(schema.sessions)
    .values(
      [OWNER, READER, STRANGER].map((userId) => ({
        id: appSession(userId),
        token: `token-${userId}`,
        userId,
        expiresAt: new Date(NOW + 7 * DAY),
        createdAt: at,
        updatedAt: at,
      })),
    );
  for (const id of [ID, OTHER_ID]) {
    await db()
      .insert(schema.artifacts)
      .values({
        id,
        ownerId: OWNER,
        type: "site",
        name: "Plan",
        state: "active",
        accessMode: "restricted",
        currentVersionId: `${id}_v1`,
        expiresAt: NOW + 10 * DAY,
        ...overrides,
      });
    await db()
      .insert(schema.versions)
      .values({
        id: `${id}_v1`,
        artifactId: id,
        number: 1,
        authorId: OWNER,
        state: "committed",
        entrypoint: "index.html",
        publishedBytes: 10,
      });
  }
  await db().insert(schema.artifactReaders).values({ artifactId: ID, email: "reader@example.com" });
}

async function issue(userId = READER, artifactId = ID, kind?: ReviewKind) {
  const result = await issueReviewHandoff(db(), {
    artifactId,
    userId,
    authSessionId: appSession(userId),
    now: NOW,
    ...(kind ? { kind } : {}),
  });
  if (!result.ok) throw new Error(`issue failed: ${result.code}`);
  return result.value;
}

const redeem = (
  code: string,
  overrides: Partial<{ artifactId: string; now: number; kind: ReviewKind }> = {},
) =>
  redeemReviewHandoff(db(), { code, artifactId: ID, kind: "frame", now: NOW + 1000, ...overrides });

const sessionCount = async () => (await db().select().from(schema.reviewSessions)).length;

describe("review access", () => {
  beforeEach(() => seed());

  it("issues a code pinned to the current version and stores only its hash", async () => {
    const issued = await issue();
    expect(issued).toMatchObject({
      name: "Plan",
      type: "site",
      versionId: `${ID}_v1`,
      entrypoint: "index.html",
      expiresAt: NOW + HANDOFF_MS,
    });
    expect(issued.sessionTag).toBe(await reviewSessionTag(issued.code));
    const [row] = await db().select().from(schema.reviewHandoffs);
    expect(row?.codeHash).toBe(await hashSecret(issued.code));
    expect(JSON.stringify(row)).not.toContain(issued.code);
    expect(row).toMatchObject({ versionId: `${ID}_v1`, userId: READER, policyGeneration: 1 });
  });

  it("refuses a code to an account the policy does not admit, like a missing artifact", async () => {
    const stranger = await issueReviewHandoff(db(), {
      artifactId: ID,
      userId: STRANGER,
      authSessionId: appSession(STRANGER),
      now: NOW,
    });
    const missing = await issueReviewHandoff(db(), {
      artifactId: "zzzzzzzzzz",
      userId: READER,
      authSessionId: appSession(READER),
      now: NOW,
    });
    expect(stranger).toEqual(missing);
    expect(stranger.ok).toBe(false);
    expect(await db().select().from(schema.reviewHandoffs)).toHaveLength(0);
  });

  it("refuses a code for an artifact without a version or that is archived", async () => {
    await seed({ currentVersionId: null });
    await expect(
      issueReviewHandoff(db(), {
        artifactId: ID,
        userId: OWNER,
        authSessionId: appSession(OWNER),
        now: NOW,
      }),
    ).resolves.toMatchObject({ ok: false, code: "not_found" });
    await seed({ state: "archived", archivedAt: NOW - DAY });
    await expect(
      issueReviewHandoff(db(), {
        artifactId: ID,
        userId: OWNER,
        authSessionId: appSession(OWNER),
        now: NOW,
      }),
    ).resolves.toMatchObject({ ok: false, code: "not_found" });
  });

  it("redeems a code once into a session for the pinned version", async () => {
    const { code } = await issue();
    const first = await redeem(code);
    expect(first).toMatchObject({
      ok: true,
      value: {
        userId: READER,
        versionId: `${ID}_v1`,
        policyGeneration: 1,
        expiresAt: NOW + 1000 + SESSION_MS,
      },
    });
    const replay = await redeem(code);
    expect(replay).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await sessionCount()).toBe(1);
    // The viewer and the session share a tag that reveals neither the code nor the session.
    const tag = await reviewSessionTag(code);
    expect(first.ok && first.value.sessionTag).toBe(tag);
    expect(tag).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(code).not.toContain(tag);
    expect(first.ok && first.value.sessionId).not.toContain(tag);
    expect(await reviewSessionTag((await issue()).code)).not.toBe(tag);
    const [session] = await db().select().from(schema.reviewSessions);
    expect(session).toMatchObject({ artifactId: ID, versionId: `${ID}_v1`, userId: READER });
  });

  it("does not redeem an expired code, a code of another artifact or after signing out", async () => {
    const expired = await issue();
    await expect(redeem(expired.code, { now: NOW + HANDOFF_MS })).resolves.toMatchObject({
      ok: false,
    });
    const other = await issue(READER, ID);
    await expect(redeem(other.code, { artifactId: OTHER_ID })).resolves.toMatchObject({
      ok: false,
    });
    const signedOut = await issue(READER, ID);
    await db().delete(schema.sessions).where(eq(schema.sessions.userId, READER));
    await expect(redeem(signedOut.code)).resolves.toMatchObject({ ok: false });
    expect(await sessionCount()).toBe(0);
  });

  it("renews a session while access holds and refuses it after a revocation", async () => {
    const { code } = await issue();
    const redeemed = await redeem(code);
    if (!redeemed.ok) throw new Error("redeem failed");
    const sessionId = redeemed.value.sessionId;
    await expect(
      refreshReviewSession(db(), { sessionId, artifactId: ID, now: NOW + 2 * 60_000 }),
    ).resolves.toMatchObject({ ok: true, value: { userId: READER, versionId: `${ID}_v1` } });
    await expect(
      refreshReviewSession(db(), { sessionId, artifactId: OTHER_ID, now: NOW + 2 * 60_000 }),
    ).resolves.toMatchObject({ ok: false, code: "not_found" });

    await db().delete(schema.artifactReaders);
    await db()
      .update(schema.artifacts)
      .set({ policyGeneration: 2 })
      .where(eq(schema.artifacts.id, ID));
    await expect(
      refreshReviewSession(db(), { sessionId, artifactId: ID, now: NOW + 3 * 60_000 }),
    ).resolves.toMatchObject({ ok: false, code: "not_found" });
  });

  it("ends a session with the app session and when it expires", async () => {
    const { code } = await issue();
    const redeemed = await redeem(code);
    if (!redeemed.ok) throw new Error("redeem failed");
    const sessionId = redeemed.value.sessionId;
    await expect(
      refreshReviewSession(db(), { sessionId, artifactId: ID, now: NOW + 1000 + SESSION_MS }),
    ).resolves.toMatchObject({ ok: false });
    await db().delete(schema.sessions).where(eq(schema.sessions.userId, READER));
    expect(await sessionCount()).toBe(0);
  });

  it("redeems a tab code only as a tab session, which is shorter, and a frame code only in a frame", async () => {
    const tab = await issue(READER, ID, "tab");
    const [row] = await db().select().from(schema.reviewHandoffs);
    expect(row?.kind).toBe("tab");
    await expect(redeem(tab.code, { kind: "frame" })).resolves.toMatchObject({ ok: false });
    await expect(redeem(tab.code, { kind: "tab" })).resolves.toMatchObject({
      ok: true,
      value: { userId: READER, versionId: `${ID}_v1`, expiresAt: NOW + 1000 + TAB_SESSION_MS },
    });
    expect(TAB_SESSION_MS).toBeLessThan(SESSION_MS);
    const frame = await issue();
    await expect(redeem(frame.code, { kind: "tab" })).resolves.toMatchObject({ ok: false });
    await expect(redeem(frame.code)).resolves.toMatchObject({ ok: true });
    expect(await sessionCount()).toBe(2);
  });

  it("ends a session at once, only on its own artifact", async () => {
    const { code } = await issue(READER, ID, "tab");
    const redeemed = await redeem(code, { kind: "tab" });
    if (!redeemed.ok) throw new Error("redeem failed");
    const sessionId = redeemed.value.sessionId;
    await expect(endReviewSession(db(), { sessionId, artifactId: OTHER_ID })).resolves.toEqual({
      ended: false,
    });
    expect(await sessionCount()).toBe(1);
    await expect(endReviewSession(db(), { sessionId, artifactId: ID })).resolves.toEqual({
      ended: true,
    });
    await expect(
      refreshReviewSession(db(), { sessionId, artifactId: ID, now: NOW + 2000 }),
    ).resolves.toMatchObject({ ok: false });
    await expect(endReviewSession(db(), { sessionId, artifactId: ID })).resolves.toEqual({
      ended: false,
    });
  });

  it("prunes expired codes and sessions in bounded batches", async () => {
    await issue();
    await issue();
    const { code } = await issue();
    await redeem(code);
    await expect(pruneReviewSessions(db(), NOW + HANDOFF_MS, 1)).resolves.toEqual({
      processed: 1,
    });
    await expect(pruneReviewSessions(db(), NOW + HANDOFF_MS)).resolves.toEqual({ processed: 2 });
    await expect(pruneReviewSessions(db(), NOW + 2000 + SESSION_MS)).resolves.toEqual({
      processed: 1,
    });
    await expect(pruneReviewSessions(db(), NOW + 2000 + SESSION_MS)).resolves.toEqual({
      processed: 0,
    });
  });
});

describe("viewer artifact", () => {
  beforeEach(() => seed());

  const view = (userId: string | null, now = NOW) =>
    getViewerArtifact(db(), { artifactId: ID, userId, now });

  it("names who is looking: the owner, a reader the policy admits", async () => {
    expect(await view(OWNER)).toEqual({
      ok: true,
      value: {
        name: "Plan",
        type: "site",
        versionNumber: 1,
        accessMode: "restricted",
        annotations: "off",
        role: "owner",
      },
    });
    const reader = await view(READER);
    expect(reader.ok && reader.value.role).toBe("reader");
  });

  it("answers a stranger exactly like a missing artifact", async () => {
    const stranger = await view(STRANGER);
    const missing = await getViewerArtifact(db(), {
      artifactId: "zzzzzzzzzz",
      userId: STRANGER,
      now: NOW,
    });
    expect(stranger).toEqual(missing);
    expect(stranger.ok).toBe(false);
  });

  it("shows anonymous visitors only public artifacts that are servable", async () => {
    expect((await view(null)).ok).toBe(false);
    await env.DB.exec("UPDATE artifacts SET access_mode = 'authenticated'");
    expect((await view(null)).ok).toBe(false);
    await env.DB.exec("UPDATE artifacts SET access_mode = 'public', annotations = 'open'");
    const open = await view(null);
    expect(open.ok && open.value).toMatchObject({ role: "anonymous", annotations: "open" });
    // Expired, archived or suspended public artifacts look missing too.
    expect((await view(null, NOW + 11 * DAY)).ok).toBe(false);
    await env.DB.exec("UPDATE artifacts SET state = 'suspended'");
    expect(await view(null)).toEqual(await view(STRANGER));
  });
});

describe("open review codes", () => {
  beforeEach(() => seed());

  it("keeps at most a few open codes per account and expires the oldest", async () => {
    const codes: string[] = [];
    for (let i = 0; i < REVIEW_SESSION.openCodesPerUser + 3; i++) {
      const result = await issueReviewHandoff(db(), {
        artifactId: ID,
        userId: READER,
        authSessionId: appSession(READER),
        now: NOW + i,
      });
      if (!result.ok) throw new Error(result.message);
      codes.push(result.value.code);
    }
    const rows = await db()
      .select()
      .from(schema.reviewHandoffs)
      .where(eq(schema.reviewHandoffs.userId, READER));
    expect(rows).toHaveLength(REVIEW_SESSION.openCodesPerUser);
    // The newest still redeems; the oldest no longer does.
    const newest = await redeemReviewHandoff(db(), {
      code: codes.at(-1) as string,
      artifactId: ID,
      kind: "frame",
      now: NOW + 100,
    });
    expect(newest.ok).toBe(true);
    const oldest = await redeemReviewHandoff(db(), {
      code: codes[0] as string,
      artifactId: ID,
      kind: "frame",
      now: NOW + 100,
    });
    expect(oldest.ok).toBe(false);
    // Another account's codes are never touched.
    await issueReviewHandoff(db(), {
      artifactId: ID,
      userId: OWNER,
      authSessionId: appSession(OWNER),
      now: NOW,
    });
    expect(
      await db()
        .select()
        .from(schema.reviewHandoffs)
        .where(eq(schema.reviewHandoffs.userId, READER)),
    ).toHaveLength(REVIEW_SESSION.openCodesPerUser);
  });
});
