// Leaving without accepting new terms (docs/legal.md, "Leaving without accepting"): the account
// deletion code is issued only to a session of an account without the current terms, works once,
// only for its account and session, and runs the existing deletion with its rules.
import { env } from "cloudflare:test";
import { TERMS_VERSION } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { SIGN_IN_EMAILS_PER_CYCLE } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  deleteAccountWithCode,
  issueAccountDeletionCode,
  requestAccountDeletion,
} from "../src/account-data.ts";
import { recordEmailsSent, suppressEmail } from "../src/email.ts";
import { placeLegalHold } from "../src/legal-holds.ts";
import { suspendArtifact } from "../src/moderation.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { artifactRow, db, MINUTE, NOW, publishSite, session, user, value } from "./fixtures.ts";

const SECRET = "test-secret-for-deletion-codes";
const regions = () => regionsFromEnv(env);
const global = () => regions().global;

/** An account on an older version of the terms, with a session. */
async function leaving() {
  const account = await user();
  await db()
    .update(schema.users)
    .set({ termsVersion: "2000-01-01" })
    .where(eq(schema.users.id, account.id));
  return { ...account, sessionId: await session(account.id) };
}

async function issue(a: { id: string; sessionId: string }, now = NOW, draw?: () => number) {
  return issueAccountDeletionCode(global(), {
    userId: a.id,
    sessionId: a.sessionId,
    secret: SECRET,
    now,
    ...(draw ? { draw } : {}),
  });
}

async function remove(a: { id: string; sessionId: string }, code: string, now = NOW) {
  return deleteAccountWithCode(regions(), {
    userId: a.id,
    sessionId: a.sessionId,
    secret: SECRET,
    code,
    now,
  });
}

async function exists(userId: string) {
  const rows = await db().select().from(schema.users).where(eq(schema.users.id, userId));
  return rows.length === 1;
}

async function acceptances(userId: string) {
  return db()
    .select()
    .from(schema.termsAcceptances)
    .where(eq(schema.termsAcceptances.userId, userId));
}

async function storedCode(userId: string) {
  const [row] = await db()
    .select()
    .from(schema.accountDeletionCodes)
    .where(eq(schema.accountDeletionCodes.userId, userId));
  return row;
}

describe("issuing an account deletion code", () => {
  it("stores only a keyed hash bound to the account and session, for five minutes", async () => {
    const a = await leaving();
    const issued = value(await issue(a, NOW, () => 123_456));
    expect(issued).toEqual({ email: a.email, code: "123456", expiresInMinutes: 5 });
    const row = await storedCode(a.id);
    expect(row).toMatchObject({
      sessionId: a.sessionId,
      attempts: 0,
      expiresAt: NOW + 5 * MINUTE,
      createdAt: NOW,
    });
    expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.codeHash).not.toContain("123456");
  });

  it("replaces an earlier code of the account", async () => {
    const a = await leaving();
    value(await issue(a, NOW, () => 111_111));
    value(await issue(a, NOW + MINUTE, () => 222_222));
    expect(await remove(a, "111111", NOW + MINUTE)).toMatchObject({ code: "invalid_input" });
    expect(await remove(a, "222222", NOW + MINUTE)).toEqual({ ok: true, value: { deleted: true } });
  });

  it("is refused to an account that accepted the current terms", async () => {
    const a = await leaving();
    await db()
      .update(schema.users)
      .set({ termsVersion: TERMS_VERSION })
      .where(eq(schema.users.id, a.id));
    expect(await issue(a)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await storedCode(a.id)).toBeUndefined();
  });

  it("is refused for a session of another account or no session", async () => {
    const a = await leaving();
    const b = await leaving();
    expect(await issue({ id: a.id, sessionId: b.sessionId })).toMatchObject({
      code: "unauthenticated",
    });
    expect(await issue({ id: a.id, sessionId: "s_missing" })).toMatchObject({
      code: "unauthenticated",
    });
    expect(await storedCode(a.id)).toBeUndefined();
  });

  it("is refused for an unverified address", async () => {
    const a = await leaving();
    await db().update(schema.users).set({ emailVerified: false }).where(eq(schema.users.id, a.id));
    expect(await issue(a)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("follows the sign-in code's suppression and capacity rules", async () => {
    const a = await leaving();
    await suppressEmail(global(), { email: a.email, reason: "hard_bounce", now: NOW });
    expect(await issue(a)).toMatchObject({
      ok: false,
      code: "forbidden",
      detail: "email_suppressed",
    });
    // A later cycle, so the other tests keep their emails.
    const later = NOW + 62 * 24 * 60 * MINUTE;
    const b = await leaving();
    await recordEmailsSent(global(), later, SIGN_IN_EMAILS_PER_CYCLE);
    expect(await issue(b, later)).toMatchObject({ ok: false, code: "capacity_unavailable" });
    expect(await storedCode(b.id)).toBeUndefined();
  });

  it("tells the sole admin of a workspace what to do before sending anything", async () => {
    const a = await leaving();
    value(
      await createWorkspace(global(), {
        slug: `l-${crypto.randomUUID().slice(0, 8)}`,
        name: "Team",
        adminUserId: a.id,
        now: NOW,
      }),
    );
    const refused = await issue(a);
    expect(refused).toMatchObject({ ok: false, code: "sole_workspace_admin" });
    expect(refused.ok ? "" : refused.message).toContain("Make another member its admin");
    expect(await storedCode(a.id)).toBeUndefined();
  });
});

describe("deleting the account with the code", () => {
  it("deletes the account with the existing deletion and records no acceptance", async () => {
    const a = await leaving();
    const published = await publishSite(a.id);
    const { code } = value(await issue(a));
    expect(await remove(a, code, NOW + MINUTE)).toEqual({ ok: true, value: { deleted: true } });
    expect(await exists(a.id)).toBe(false);
    expect(await acceptances(a.id)).toEqual([]);
    expect(await artifactRow(published.artifactId)).toMatchObject({ state: "purging" });
    expect(await storedCode(a.id)).toBeUndefined();
  });

  it("refuses a wrong code and ends it after three attempts", async () => {
    const a = await leaving();
    const { code } = value(await issue(a, NOW, () => 424_242));
    expect(code).toBe("424242");
    for (const wrong of ["000000", "111111"]) {
      expect(await remove(a, wrong)).toMatchObject({ ok: false, code: "invalid_input" });
    }
    expect((await storedCode(a.id))?.attempts).toBe(2);
    expect(await remove(a, "222222")).toMatchObject({ code: "invalid_input" });
    expect(await storedCode(a.id)).toBeUndefined();
    // Even the right code is refused now.
    expect(await remove(a, code)).toMatchObject({ code: "invalid_input" });
    expect(await exists(a.id)).toBe(true);
  });

  it("refuses an expired code", async () => {
    const a = await leaving();
    const { code } = value(await issue(a));
    expect(await remove(a, code, NOW + 5 * MINUTE)).toMatchObject({ code: "invalid_input" });
    expect(await exists(a.id)).toBe(true);
    expect(await storedCode(a.id)).toBeUndefined();
  });

  it("works once", async () => {
    const a = await leaving();
    const { code } = value(await issue(a));
    const extra = await session(a.id);
    // The racing request's code is spent by the first: whatever the order, one deletion.
    const [first, second] = await Promise.all([remove(a, code), remove(a, code)]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(await exists(a.id)).toBe(false);
    expect(extra).toBeTruthy();
  });

  it("works only for the account and the session that asked for it", async () => {
    const a = await leaving();
    const b = await leaving();
    const { code } = value(await issue(a));
    // Another account with a's code, through its own session.
    expect(await remove(b, code)).toMatchObject({ ok: false, code: "invalid_input" });
    // Another account naming a, with its own session.
    expect(await remove({ id: a.id, sessionId: b.sessionId }, code)).toMatchObject({
      code: "unauthenticated",
    });
    // Another session of the same account.
    const other = await session(a.id);
    expect(await remove({ id: a.id, sessionId: other }, code)).toMatchObject({
      code: "invalid_input",
    });
    expect(await exists(a.id)).toBe(true);
    expect(await exists(b.id)).toBe(true);
  });

  it("goes with the session that asked for it", async () => {
    const a = await leaving();
    value(await issue(a));
    await db().delete(schema.sessions).where(eq(schema.sessions.id, a.sessionId));
    expect(await storedCode(a.id)).toBeUndefined();
  });

  it("is refused once the account accepted the current terms", async () => {
    const a = await leaving();
    const { code } = value(await issue(a));
    await db()
      .update(schema.users)
      .set({ termsVersion: TERMS_VERSION })
      .where(eq(schema.users.id, a.id));
    expect(await remove(a, code)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await exists(a.id)).toBe(true);
  });

  it("refuses the sole admin of a workspace without spending the code", async () => {
    const a = await leaving();
    const { code } = value(await issue(a));
    const created = value(
      await createWorkspace(global(), {
        slug: `l-${crypto.randomUUID().slice(0, 8)}`,
        name: "Team",
        adminUserId: a.id,
        now: NOW,
      }),
    );
    expect(await remove(a, code)).toMatchObject({ ok: false, code: "sole_workspace_admin" });
    expect(await storedCode(a.id)).toMatchObject({ attempts: 0 });
    // Another admin, and the same code deletes it; the workspace stays.
    const other = await user();
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: created.id, userId: other.id, role: "admin", updatedAt: NOW });
    expect(await remove(a, code)).toEqual({ ok: true, value: { deleted: true } });
    const [workspace] = await db()
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, created.id));
    expect(workspace).toBeDefined();
  });

  it("leaves an artifact under a legal hold suspended, with the deletion pending", async () => {
    const a = await leaving();
    const held = await publishSite(a.id);
    await suspendArtifact(db(), { artifactId: held.artifactId, reason: "spam", now: NOW });
    value(
      await placeLegalHold(db(), {
        artifactId: held.artifactId,
        ground: "Authority",
        releaseAt: null,
        now: NOW,
      }),
    );
    const { code } = value(await issue(a));
    expect(await remove(a, code)).toEqual({ ok: true, value: { deleted: true } });
    expect(await artifactRow(held.artifactId)).toMatchObject({ state: "suspended" });
    const [pending] = await db()
      .select()
      .from(schema.accountDeletions)
      .where(eq(schema.accountDeletions.userId, a.id));
    expect(pending).toBeDefined();
  });

  it("cannot stand in for the recent sign-in the Settings deletion needs", async () => {
    const a = await leaving();
    const stale = await session(a.id, NOW - 60 * MINUTE);
    value(await issue({ id: a.id, sessionId: stale }));
    expect(
      await requestAccountDeletion(regions(), {
        userId: a.id,
        sessionId: stale,
        confirmEmail: a.email,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "reauthentication_required" });
  });
});
