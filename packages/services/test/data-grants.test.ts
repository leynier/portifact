import { env } from "cloudflare:test";
import { DATA_GRANT, TERMS_VERSION } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { journalKey } from "@portifact/domain/artifact-data";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyTombstones,
  claimVisitorId,
  dataGrantControl,
  exportTombstones,
  issueDataGrantCode,
  listDataGrants,
  nonceDigest,
  pruneDataGrants,
  redeemDataGrantCode,
  renewDataGrant,
  retireJournalEntry,
  revokeDataGrants,
} from "../src/index.ts";

const ID = "k7d2qm4xab";
const NO_DATA = "p3n5wq7yzc";
const NOW = Date.UTC(2026, 10, 13, 12);
const DAY = 86_400_000;
const HOST = `${ID}.portifact.dev`;
const OWNER = "u_owner";
const READER = "u_reader";
const STRANGER = "u_stranger";
const regions = () => regionsFromEnv(env);
const db = () => regions().get("default").db;

const appSession = (userId: string) => `as_${userId}`;

async function seed() {
  for (const table of [
    "data_grant_codes",
    "data_grants",
    "artifact_data",
    "artifact_readers",
    "artifacts",
    "sessions",
    "users",
    "tombstones",
    "rate_limits",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const listed = await env.ARTIFACTS.list({ prefix: "system/" });
  for (const object of listed.objects) await env.ARTIFACTS.delete(object.key);
  const at = new Date(NOW - 30 * DAY);
  await db()
    .insert(schema.users)
    .values(
      [
        { id: OWNER, name: "Owner", email: "owner@example.com" },
        { id: READER, name: "Rea Der", email: "reader@example.com" },
        { id: STRANGER, name: "Stranger", email: "stranger@example.com" },
      ].map((user) => ({
        ...user,
        emailVerified: true,
        termsVersion: TERMS_VERSION,
        createdAt: at,
        updatedAt: at,
      })),
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
  for (const id of [ID, NO_DATA]) {
    await db()
      .insert(schema.artifacts)
      .values({
        id,
        ownerId: OWNER,
        type: "site",
        name: "Board",
        state: "active",
        accessMode: "restricted",
        currentVersionId: "v1",
        expiresAt: NOW + 60 * DAY,
      });
  }
  await db().insert(schema.artifactReaders).values({ artifactId: ID, email: "reader@example.com" });
  await db().insert(schema.artifactData).values({ artifactId: ID, updatedAt: NOW });
}

const target = (userId = READER, artifactId = ID, requestedHost: string | null = null) => ({
  artifactId,
  userId,
  requestedHost,
  contentDomain: "portifact.dev",
  customDomains: false,
  now: NOW,
});

async function issue(userId = READER, nonce = "n".repeat(43), artifactId = ID) {
  return issueDataGrantCode(db(), env.ARTIFACTS, {
    ...target(userId, artifactId),
    authSessionId: appSession(userId),
    nonceHash: await nonceDigest(nonce),
  });
}

async function issued(userId = READER, nonce = "n".repeat(43)) {
  const result = await issue(userId, nonce);
  if (!result.ok) throw new Error(`issue failed: ${result.code}`);
  return result.value.code;
}

async function redeem(code: string, nonce: string | null = "n".repeat(43), now = NOW + 1000) {
  return redeemDataGrantCode(db(), {
    code,
    artifactId: ID,
    nonceHash: nonce === null ? null : await nonceDigest(nonce),
    host: HOST,
    now,
  });
}

describe("data grants", () => {
  beforeEach(() => seed());

  it("draws the control for a reader: host, owner and the name the page learns", async () => {
    const control = await dataGrantControl(db(), target());
    expect(control).toEqual({
      ok: true,
      value: {
        artifactId: ID,
        artifactName: "Board",
        host: HOST,
        owner: { kind: "user", name: "Owner" },
        displayName: "Rea Der",
        grantDays: 30,
      },
    });
  });

  it("answers a stranger, an artifact without data and a foreign host like a missing artifact", async () => {
    for (const input of [
      target(STRANGER),
      target(READER, NO_DATA),
      target(READER, ID, "evil.example"),
    ]) {
      const result = await dataGrantControl(db(), input);
      expect(result).toMatchObject({ ok: false, code: "not_found" });
    }
    expect(await issue(STRANGER)).toMatchObject({ ok: false, code: "not_found" });
    expect(await db().select().from(schema.dataGrants)).toHaveLength(0);
  });

  it("redeems a code once, in the browser that began, into the reader's visitor ID", async () => {
    const code = await issued();
    const first = await redeem(code);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).toMatchObject({ userId: READER, name: "Rea Der", write: true });
    expect(first.value.visitorId).toMatch(/^v_[A-Za-z0-9_-]{24}$/);
    expect(first.value.expiresAt).toBe(NOW + DATA_GRANT.grantTtlSeconds * 1000);
    // A second use, whatever the nonce, gets nothing.
    expect(await redeem(code)).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("refuses a code with another browser's nonce, without one, on another host or late", async () => {
    const code = await issued();
    expect(await redeem(code, "m".repeat(43))).toMatchObject({ ok: false });
    expect(await redeem(code, null)).toMatchObject({ ok: false });
    expect(
      await redeemDataGrantCode(db(), {
        code,
        artifactId: ID,
        nonceHash: await nonceDigest("n".repeat(43)),
        host: "p3n5wq7yzc.portifact.dev",
        now: NOW + 1000,
      }),
    ).toMatchObject({ ok: false });
    expect(await redeem(code, "n".repeat(43), NOW + 61_000)).toMatchObject({ ok: false });
    // None of them spent it: the right browser, in time, still redeems.
    expect((await redeem(code)).ok).toBe(true);
  });

  it("gives every grant of a person on an artifact the same visitor ID", async () => {
    const first = await redeem(await issued());
    const second = await redeem(await issued(READER, "o".repeat(43)), "o".repeat(43));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.visitorId).toBe(first.value.visitorId);
    expect(second.value.grantId).not.toBe(first.value.grantId);
  });

  it("refuses a grant once the person's journal entry is retired", async () => {
    await retireJournalEntry(env.ARTIFACTS, READER, ID, NOW - 1);
    expect(await issue()).toMatchObject({ ok: false, code: "not_found" });
    expect(await db().select().from(schema.dataGrants)).toHaveLength(0);
  });

  it("keeps the first claim when two first grants race", async () => {
    const [a, b] = await Promise.all([
      claimVisitorId(env.ARTIFACTS, READER, ID, NOW),
      claimVisitorId(env.ARTIFACTS, READER, ID, NOW),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).toBe(b.value);
    const stored = (await (await env.ARTIFACTS.get(journalKey(READER, ID)))?.json()) as {
      visitorId: string;
    };
    expect(stored.visitorId).toBe(a.value);
  });

  it("limits codes per person and artifact a minute", async () => {
    for (let i = 0; i < DATA_GRANT.codesPerMinute; i++) expect((await issue()).ok).toBe(true);
    expect(await issue()).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("stops renewing once the grant is revoked, the app session ends or access is lost", async () => {
    const granted = await redeem(await issued());
    if (!granted.ok) throw new Error("redeem failed");
    const renew = (now = NOW + 61_000) =>
      renewDataGrant(db(), { grantId: granted.value.grantId, artifactId: ID, now });
    expect((await renew()).ok).toBe(true);

    await db().delete(schema.artifactReaders).where(eq(schema.artifactReaders.artifactId, ID));
    expect(await renew()).toMatchObject({ ok: false });
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: ID, email: "reader@example.com" });
    expect((await renew()).ok).toBe(true);

    await db().delete(schema.sessions).where(eq(schema.sessions.userId, READER));
    expect(await renew()).toMatchObject({ ok: false });
  });

  it("renews without write while the account has not accepted the current terms", async () => {
    const granted = await redeem(await issued());
    if (!granted.ok) throw new Error("redeem failed");
    await db().update(schema.users).set({ termsVersion: "old" }).where(eq(schema.users.id, READER));
    const renewed = await renewDataGrant(db(), {
      grantId: granted.value.grantId,
      artifactId: ID,
      now: NOW + 61_000,
    });
    expect(renewed).toMatchObject({ ok: true, value: { write: false } });
  });

  it("ends at its 30 days", async () => {
    const granted = await redeem(await issued());
    if (!granted.ok) throw new Error("redeem failed");
    const renewed = await renewDataGrant(db(), {
      grantId: granted.value.grantId,
      artifactId: ID,
      now: NOW + DATA_GRANT.grantTtlSeconds * 1000,
    });
    expect(renewed).toMatchObject({ ok: false });
  });

  it("revokes only the person's grants on the artifact, with a tombstone a restore re-applies", async () => {
    const granted = await redeem(await issued());
    if (!granted.ok) throw new Error("redeem failed");
    const markers = await exportTombstones(regions());
    expect(await revokeDataGrants(db(), { userId: STRANGER, artifactId: ID, now: NOW })).toEqual({
      revoked: 0,
    });
    expect(
      await revokeDataGrants(db(), { userId: READER, artifactId: ID, now: NOW + 2000 }),
    ).toEqual({ revoked: 1 });
    const renew = () =>
      renewDataGrant(db(), { grantId: granted.value.grantId, artifactId: ID, now: NOW + 3000 });
    expect(await renew()).toMatchObject({ ok: false });

    // A restore to before the revocation brings the open grant back; the exported marker ends it.
    const after = await exportTombstones(regions());
    expect(after.filter((marker) => marker.kind === "data_grant")).toEqual([
      { kind: "data_grant", id: granted.value.grantId, deletedAt: NOW + 2000 },
    ]);
    await db()
      .update(schema.dataGrants)
      .set({ revokedAt: null })
      .where(eq(schema.dataGrants.id, granted.value.grantId));
    await env.DB.exec("DELETE FROM tombstones");
    expect(markers.filter((marker) => marker.kind === "data_grant")).toHaveLength(0);
    const applied = await applyTombstones(regions(), after, NOW + 4000);
    expect(applied.dataGrants).toBe(1);
    expect(await renew()).toMatchObject({ ok: false });
  });

  it("lists the artifacts a person shared data with, and only theirs", async () => {
    await redeem(await issued());
    // A code that never redeemed is not a grant.
    await issued(READER, "o".repeat(43));
    const items = await listDataGrants(db(), {
      userId: READER,
      contentDomain: "portifact.dev",
      now: NOW + 2000,
    });
    expect(items).toEqual([
      {
        artifactId: ID,
        artifactName: "Board",
        host: HOST,
        openGrants: 1,
        firstGrantedAt: new Date(NOW).toISOString(),
        lastGrantedAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + DATA_GRANT.grantTtlSeconds * 1000).toISOString(),
      },
    ]);
    expect(
      await listDataGrants(db(), { userId: STRANGER, contentDomain: "portifact.dev", now: NOW }),
    ).toEqual([]);
  });

  it("prunes spent codes, unredeemed grants and grants 30 days after they ended", async () => {
    const granted = await redeem(await issued());
    if (!granted.ok) throw new Error("redeem failed");
    await issued(READER, "o".repeat(43));
    await revokeDataGrants(db(), { userId: READER, artifactId: ID, now: NOW + 2000 });
    expect((await pruneDataGrants(db(), NOW + 3 * 60_000)).processed).toBe(3);
    expect(await db().select().from(schema.dataGrants)).toHaveLength(1);
    await pruneDataGrants(db(), NOW + 2000 + DATA_GRANT.endedKeepMs);
    expect(await db().select().from(schema.dataGrants)).toHaveLength(0);
  });
});
