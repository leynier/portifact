import { env } from "cloudflare:test";
import { READ_SESSION } from "@portifact/contracts";
import { createDb, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  checkReadAccess,
  hashSecret,
  issueReadHandoff,
  pruneReadSessions,
  randomToken,
  redeemReadHandoff,
  refreshReadSession,
} from "../src/index.ts";

const ID = "k7d2qm4xab";
const OTHER_ID = "p3n5wq7yzc";
const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
const HANDOFF_MS = READ_SESSION.handoffTtlSeconds * 1000;
const SESSION_MS = READ_SESSION.sessionTtlSeconds * 1000;
const db = () => createDb(env.DB);

const OWNER = "u_owner";
const READER = "u_reader";
const STRANGER = "u_stranger";
const UNVERIFIED = "u_unverified";

async function seed(overrides: Partial<typeof schema.artifacts.$inferInsert> = {}) {
  for (const table of [
    "read_sessions",
    "read_handoffs",
    "artifact_readers",
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
        { id: OWNER, name: "Owner", email: "owner@example.com", emailVerified: true },
        { id: READER, name: "Reader", email: "Reader@Example.com", emailVerified: true },
        { id: STRANGER, name: "Stranger", email: "stranger@example.com", emailVerified: true },
        {
          id: UNVERIFIED,
          name: "Unverified",
          email: "unverified@example.com",
          emailVerified: false,
        },
      ].map((user) => ({ ...user, createdAt: at, updatedAt: at })),
    );
  // One app.portifact.com session per account, the one that signed in to the artifact.
  await db()
    .insert(schema.sessions)
    .values(
      [OWNER, READER, STRANGER, UNVERIFIED].map((userId) => ({
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
        currentVersionId: "v1",
        expiresAt: NOW + 10 * DAY,
        ...overrides,
      });
  }
  await db()
    .insert(schema.artifactReaders)
    .values([
      { artifactId: ID, email: "reader@example.com" },
      { artifactId: ID, email: "unverified@example.com" },
    ]);
}

/** ID of the app session (Better Auth) that `userId` signed in with. */
const appSession = (userId: string) => `as_${userId}`;

const signOut = (userId: string) =>
  db().delete(schema.sessions).where(eq(schema.sessions.userId, userId));

const check = (userId: string, now = NOW) => checkReadAccess(db(), { artifactId: ID, userId, now });

async function issue(userId = READER, state = "state-nonce", artifactId = ID) {
  const result = await issueReadHandoff(db(), {
    artifactId,
    userId,
    authSessionId: appSession(userId),
    state,
    now: NOW,
  });
  if (!result.ok) throw new Error(`issue failed: ${result.code}`);
  return result.value.code;
}

const redeem = (
  code: string,
  overrides: Partial<{ artifactId: string; states: string[]; now: number }> = {},
) =>
  redeemReadHandoff(db(), {
    code,
    artifactId: ID,
    states: ["state-nonce"],
    now: NOW + 1000,
    ...overrides,
  });

async function sessionCount(): Promise<number> {
  return (await db().select().from(schema.readSessions)).length;
}

describe("read access", () => {
  beforeEach(() => seed());

  it("admits the owner and verified readers of a restricted artifact", async () => {
    expect(await check(OWNER)).toEqual({ ok: true, value: { userId: OWNER, policyGeneration: 1 } });
    // The reader's account email is mixed case; the list holds it lowercased.
    expect((await check(READER)).ok).toBe(true);
  });

  it("refuses other accounts and readers whose email is not verified", async () => {
    for (const userId of [STRANGER, UNVERIFIED, "u_missing"]) {
      const result = await check(userId);
      expect(result).toMatchObject({ ok: false, code: "not_found" });
    }
  });

  it("admits any account to an authenticated artifact and everyone to a public one", async () => {
    await seed({ accessMode: "authenticated" });
    expect((await check(STRANGER)).ok).toBe(true);
    await seed({ accessMode: "public" });
    expect((await check(STRANGER)).ok).toBe(true);
  });

  it("answers a missing artifact like a forbidden one", async () => {
    const missing = await checkReadAccess(db(), {
      artifactId: "zzzzzzzzzz",
      userId: OWNER,
      now: NOW,
    });
    const forbidden = await check(STRANGER);
    expect(missing).toEqual(forbidden);
  });

  it("refuses artifacts that are not servable, even to the owner", async () => {
    for (const overrides of [
      { expiresAt: NOW - 1 },
      { state: "draft" as const },
      { state: "suspended" as const },
      { state: "archived" as const, archivedAt: NOW - DAY },
      { currentVersionId: null },
    ]) {
      await seed(overrides);
      expect((await check(OWNER)).ok).toBe(false);
    }
  });

  it("reports the current policy generation", async () => {
    await db()
      .update(schema.artifacts)
      .set({ policyGeneration: 7 })
      .where(eq(schema.artifacts.id, ID));
    expect(await check(OWNER)).toMatchObject({ ok: true, value: { policyGeneration: 7 } });
  });
});

describe("read handoffs", () => {
  beforeEach(() => seed());

  it("issues a code stored only as a hash and redeems it into a read session", async () => {
    const code = await issue();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [stored] = await db().select().from(schema.readHandoffs);
    expect(stored).toMatchObject({
      codeHash: await hashSecret(code),
      stateHash: await hashSecret("state-nonce"),
      artifactId: ID,
      userId: READER,
      policyGeneration: 1,
      authSessionId: appSession(READER),
      expiresAt: NOW + HANDOFF_MS,
      usedAt: null,
    });

    const result = await redeem(code);
    expect(result).toMatchObject({
      ok: true,
      value: {
        userId: READER,
        policyGeneration: 1,
        expiresAt: NOW + 1000 + SESSION_MS,
        state: "state-nonce",
      },
    });
    if (!result.ok) return;
    const [session] = await db().select().from(schema.readSessions);
    expect(session).toMatchObject({
      id: result.value.sessionId,
      artifactId: ID,
      userId: READER,
      authSessionId: appSession(READER),
    });
  });

  it("redeems with whichever of the browser's open transactions the code was issued for", async () => {
    const code = await issue(READER, "second-tab");
    expect(await redeem(code, { states: ["first-tab", "second-tab", "third-tab"] })).toMatchObject({
      ok: true,
      value: { state: "second-tab" },
    });
    expect((await redeem(await issue(), { states: [] })).ok).toBe(false);
  });

  it("refuses to redeem a code once the account signed out of the app", async () => {
    const code = await issue();
    await signOut(READER);
    expect((await redeem(code)).ok).toBe(false);
    expect(await sessionCount()).toBe(0);
  });

  it("refuses to redeem a code once the app session expired", async () => {
    const code = await issue();
    await db()
      .update(schema.sessions)
      .set({ expiresAt: new Date(NOW + 1000) })
      .where(eq(schema.sessions.userId, READER));
    expect((await redeem(code)).ok).toBe(false);
    expect(await sessionCount()).toBe(0);
  });

  it("does not issue a code to an account without access", async () => {
    const result = await issueReadHandoff(db(), {
      artifactId: ID,
      userId: STRANGER,
      authSessionId: appSession(STRANGER),
      state: "s",
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(await db().select().from(schema.readHandoffs)).toHaveLength(0);
  });

  it("redeems a code once", async () => {
    const code = await issue();
    expect((await redeem(code)).ok).toBe(true);
    expect(await redeem(code)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await sessionCount()).toBe(1);
  });

  it("creates one session when two redemptions race", async () => {
    const code = await issue();
    const results = await Promise.all([redeem(code), redeem(code), redeem(code)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await sessionCount()).toBe(1);
  });

  it("refuses an expired code", async () => {
    const code = await issue();
    expect((await redeem(code, { now: NOW + HANDOFF_MS })).ok).toBe(false);
    expect(await sessionCount()).toBe(0);
  });

  it("refuses a code on another artifact origin", async () => {
    const code = await issue();
    expect((await redeem(code, { artifactId: OTHER_ID })).ok).toBe(false);
    // The failed attempt does not burn the code for its own origin.
    expect((await redeem(code)).ok).toBe(true);
  });

  it("refuses a code from another browser's transaction", async () => {
    const code = await issue();
    expect((await redeem(code, { states: ["attacker-nonce"] })).ok).toBe(false);
    expect(await sessionCount()).toBe(0);
  });

  it("refuses unknown codes", async () => {
    await issue();
    expect((await redeem(randomToken())).ok).toBe(false);
  });
});

describe("read session refresh", () => {
  beforeEach(() => seed());

  async function session(userId = READER) {
    const result = await redeem(await issue(userId));
    if (!result.ok) throw new Error("redeem failed");
    return result.value.sessionId;
  }

  const refresh = (sessionId: string, now = NOW + 120_000, artifactId = ID) =>
    refreshReadSession(db(), { sessionId, artifactId, now });

  it("renews claims while the account keeps access", async () => {
    const id = await session();
    await db()
      .update(schema.artifacts)
      .set({ policyGeneration: 2 })
      .where(eq(schema.artifacts.id, ID));
    expect(await refresh(id)).toEqual({
      ok: true,
      value: {
        sessionId: id,
        userId: READER,
        policyGeneration: 2,
        expiresAt: NOW + 1000 + SESSION_MS,
      },
    });
  });

  it("denies once the reader is removed from the list", async () => {
    const id = await session();
    await db()
      .delete(schema.artifactReaders)
      .where(eq(schema.artifactReaders.email, "reader@example.com"));
    expect(await refresh(id)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("denies once the artifact is archived", async () => {
    const id = await session(OWNER);
    await db()
      .update(schema.artifacts)
      .set({ state: "archived", archivedAt: NOW })
      .where(eq(schema.artifacts.id, ID));
    expect((await refresh(id)).ok).toBe(false);
  });

  it("denies an expired session, an unknown session and a session of another artifact", async () => {
    const id = await session();
    expect((await refresh(id, NOW + 1000 + SESSION_MS)).ok).toBe(false);
    expect((await refresh(randomToken())).ok).toBe(false);
    expect((await refresh(id, NOW + 120_000, OTHER_ID)).ok).toBe(false);
  });

  it("ends the read session when the account signs out of the app", async () => {
    const id = await session();
    await signOut(READER);
    expect(await refresh(id)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("ends the read session when the app session expires", async () => {
    const id = await session();
    await db()
      .update(schema.sessions)
      .set({ expiresAt: new Date(NOW + 120_000) })
      .where(eq(schema.sessions.userId, READER));
    expect((await refresh(id, NOW + 120_000 - 1)).ok).toBe(true);
    expect((await refresh(id, NOW + 120_000)).ok).toBe(false);
  });

  it("keeps read sessions of other app sessions after one signs out", async () => {
    const id = await session();
    const owner = await session(OWNER);
    await signOut(READER);
    expect((await refresh(id)).ok).toBe(false);
    expect((await refresh(owner)).ok).toBe(true);
  });

  it("ends sessions when the account is deleted", async () => {
    const id = await session();
    await db().delete(schema.users).where(eq(schema.users.id, READER));
    expect(await sessionCount()).toBe(0);
    expect((await refresh(id)).ok).toBe(false);
  });
});

describe("read session pruning", () => {
  beforeEach(() => seed());

  it("deletes expired handoffs and sessions and keeps live ones", async () => {
    const used = await issue();
    await redeem(used);
    await issue(OWNER, "other-nonce");
    expect(await pruneReadSessions(db(), NOW + HANDOFF_MS - 1)).toEqual({ processed: 0 });
    expect(await pruneReadSessions(db(), NOW + HANDOFF_MS)).toEqual({ processed: 2 });
    expect(await sessionCount()).toBe(1);
    expect(await pruneReadSessions(db(), NOW + 1000 + SESSION_MS)).toEqual({ processed: 1 });
    expect(await pruneReadSessions(db(), NOW + 1000 + SESSION_MS)).toEqual({ processed: 0 });
  });

  it("deletes in bounded batches", async () => {
    for (const state of ["a", "b", "c"]) await issue(READER, state);
    const later = NOW + HANDOFF_MS;
    expect(await pruneReadSessions(db(), later, 2)).toEqual({ processed: 2 });
    expect(await db().select().from(schema.readHandoffs)).toHaveLength(1);
    expect(await pruneReadSessions(db(), later, 2)).toEqual({ processed: 1 });
    expect(await pruneReadSessions(db(), later, 2)).toEqual({ processed: 0 });
  });
});
