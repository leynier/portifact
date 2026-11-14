// Anonymous grants of artifact data (decision 0026, delivery 9): issued only where anonymous
// writing is open, limited per address and per artifact, redeemed once with the browser that
// began on the host they were issued for, renewed only while the artifact stays open to anyone,
// pruned after they end, and closed by a transfer, which gives writers back to signed-in visitors.
import { env } from "cloudflare:test";
import { DATA_GRANT, DEFAULT_POLICY, TERMS_VERSION } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  anonymousDataGrantControl,
  dataAnonymousEnabled,
  issueAnonymousDataGrantCode,
  nonceDigest,
  pruneDataGrants,
  redeemAnonymousDataGrantCode,
  renewAnonymousDataGrant,
} from "../src/index.ts";

const ID = "q4anonymzz";
const NOW = Date.UTC(2026, 10, 14, 12);
const DAY = 86_400_000;
const HOST = `${ID}.portifact.dev`;
const OWNER = "u_anon_owner";
const db = () => regionsFromEnv(env).get("default").db;
const NONCE = "m".repeat(43);

beforeEach(async () => {
  for (const table of [
    "data_anonymous_grants",
    "artifact_data",
    "artifacts",
    "users",
    "rate_limits",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  await db()
    .insert(schema.users)
    .values({
      id: OWNER,
      name: "Owner",
      email: "anon-owner@example.com",
      emailVerified: true,
      termsVersion: TERMS_VERSION,
      createdAt: new Date(NOW - DAY),
      updatedAt: new Date(NOW - DAY),
    });
  await db()
    .insert(schema.artifacts)
    .values({
      id: ID,
      ownerId: OWNER,
      type: "site",
      name: "Guestbook",
      state: "active",
      accessMode: "public",
      currentVersionId: "v1",
      expiresAt: NOW + 60 * DAY,
    });
  await db()
    .insert(schema.artifactData)
    .values({ artifactId: ID, writers: "anyone", updatedAt: NOW });
});

const target = (overrides: { enabled?: boolean; now?: number; addressKey?: string } = {}) => ({
  artifactId: ID,
  requestedHost: null,
  contentDomain: "portifact.dev",
  customDomains: false,
  enabled: overrides.enabled ?? true,
  now: overrides.now ?? NOW,
});

async function issue(overrides: Parameters<typeof target>[0] = {}) {
  return issueAnonymousDataGrantCode(db(), {
    ...target(overrides),
    nonceHash: await nonceDigest(NONCE),
    addressKey: overrides.addressKey ?? "a".repeat(32),
  });
}

async function redeem(code: string, now = NOW, nonce = NONCE, host = HOST) {
  return redeemAnonymousDataGrantCode(db(), {
    code,
    artifactId: ID,
    nonceHash: await nonceDigest(nonce),
    host,
    enabled: true,
    now,
  });
}

describe("anonymous grants", () => {
  it("is on only with both switches exactly true", () => {
    expect(
      dataAnonymousEnabled({ ARTIFACT_DATA_ENABLED: "true", DATA_ANONYMOUS_ENABLED: "true" }),
    ).toBe(true);
    expect(
      dataAnonymousEnabled({ ARTIFACT_DATA_ENABLED: "true", DATA_ANONYMOUS_ENABLED: "1" }),
    ).toBe(false);
    expect(dataAnonymousEnabled({ DATA_ANONYMOUS_ENABLED: "true" })).toBe(false);
  });

  it("issues, redeems once with the beginning browser and renews while open", async () => {
    const control = await anonymousDataGrantControl(db(), target());
    expect(control).toMatchObject({
      ok: true,
      value: { host: HOST, owner: { kind: "user", name: "Owner" } },
    });
    const issued = await issue();
    if (!issued.ok) throw new Error(issued.code);
    expect(issued.value.host).toBe(HOST);
    // Another browser's nonce or another host redeems nothing, and spends nothing.
    expect((await redeem(issued.value.code, NOW, "x".repeat(43))).ok).toBe(false);
    expect((await redeem(issued.value.code, NOW, NONCE, "elsewhere.example")).ok).toBe(false);
    const live = await redeem(issued.value.code);
    if (!live.ok) throw new Error(live.code);
    expect(live.value).toMatchObject({ userId: "", name: "", write: true });
    expect(live.value.visitorId).toMatch(/^v_/);
    expect(live.value.expiresAt).toBe(NOW + DATA_GRANT.anonymousGrantTtlSeconds * 1000);
    // Once only.
    expect((await redeem(issued.value.code)).ok).toBe(false);
    const renewed = await renewAnonymousDataGrant(db(), {
      grantId: live.value.grantId,
      artifactId: ID,
      enabled: true,
      now: NOW + 60_000,
    });
    expect(renewed.ok).toBe(true);
    // Off, or past its end, it does not renew.
    for (const [enabled, now] of [
      [false, NOW + 60_000],
      [true, live.value.expiresAt],
    ] as const) {
      expect(
        (
          await renewAnonymousDataGrant(db(), {
            grantId: live.value.grantId,
            artifactId: ID,
            enabled,
            now,
          })
        ).ok,
      ).toBe(false);
    }
  });

  it("refuses a late code and an unredeemed grant", async () => {
    const issued = await issue();
    if (!issued.ok) throw new Error(issued.code);
    expect((await redeem(issued.value.code, NOW + DATA_GRANT.codeTtlSeconds * 1000)).ok).toBe(
      false,
    );
    const [row] = await db().select().from(schema.dataAnonymousGrants);
    const renewed = await renewAnonymousDataGrant(db(), {
      grantId: row?.id as string,
      artifactId: ID,
      enabled: true,
      now: NOW,
    });
    expect(renewed.ok).toBe(false);
  });

  it("issues nothing while closed, and limits per address and per artifact", async () => {
    expect(await issue({ enabled: false })).toMatchObject({ ok: false, code: "not_found" });
    for (let i = 0; i < DATA_GRANT.anonymousPerIpPerHour; i++) {
      expect((await issue({ addressKey: "b".repeat(32) })).ok).toBe(true);
    }
    expect(await issue({ addressKey: "b".repeat(32) })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    await env.DB.prepare("UPDATE rate_limits SET count = ? WHERE key = ?")
      .bind(DATA_GRANT.anonymousPerArtifactPerHour, `data_anon:artifact:${ID}`)
      .run();
    expect(await issue({ addressKey: "c".repeat(32) })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    // An hour later both windows start again.
    expect((await issue({ addressKey: "b".repeat(32), now: NOW + 3_600_000 })).ok).toBe(true);
  });

  it("prunes unused codes and ended grants, and keeps live ones", async () => {
    const unused = await issue();
    const used = await issue({ addressKey: "d".repeat(32) });
    if (!unused.ok || !used.ok) throw new Error("issue failed");
    expect((await redeem(used.value.code)).ok).toBe(true);
    await pruneDataGrants(db(), NOW + 3 * 60_000);
    expect(await db().select().from(schema.dataAnonymousGrants)).toHaveLength(1);
    const ended = NOW + DATA_GRANT.anonymousGrantTtlSeconds * 1000 + DATA_GRANT.endedKeepMs;
    await pruneDataGrants(db(), ended);
    expect(await db().select().from(schema.dataAnonymousGrants)).toHaveLength(0);
  });

  it("goes with the artifact", async () => {
    expect((await issue()).ok).toBe(true);
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, ID));
    expect(await db().select().from(schema.dataAnonymousGrants)).toHaveLength(0);
  });

  it("goes on the artifact's active custom host only, and nowhere it was not asked", async () => {
    const custom = "guestbook.example.com";
    const withHost = (requestedHost: string | null) => ({
      ...target(),
      requestedHost,
      customDomains: true,
    });
    // Asked for a host the artifact does not hold: like a missing artifact.
    expect((await anonymousDataGrantControl(db(), withHost(custom))).ok).toBe(false);
    await env.DB.prepare("UPDATE artifacts SET custom_host = ? WHERE id = ?")
      .bind(custom, ID)
      .run();
    // Its own host, but not active yet.
    expect((await anonymousDataGrantControl(db(), withHost(custom))).ok).toBe(false);
    await db().insert(schema.customDomains).values({
      hostname: custom,
      ownerId: OWNER,
      artifactId: ID,
      region: "default",
      state: "active",
      token: "domain-token",
      verifiedAt: NOW,
      checkedAt: NOW,
    });
    expect(await anonymousDataGrantControl(db(), withHost(custom))).toMatchObject({
      ok: true,
      value: { host: custom },
    });
    // Without asking, the `.dev` host.
    expect(await anonymousDataGrantControl(db(), withHost(null))).toMatchObject({
      ok: true,
      value: { host: HOST },
    });
  });

  it("names a workspace owner and holds it to its plan and policy", async () => {
    const ws = "ws_anongrant00000000000";
    await db()
      .insert(schema.workspaces)
      .values({ id: ws, slug: "anon-grant", name: "Guild", createdBy: OWNER, updatedAt: NOW });
    await env.DB.prepare("UPDATE artifacts SET owner_id = ? WHERE id = ?").bind(ws, ID).run();
    expect((await anonymousDataGrantControl(db(), target())).ok).toBe(false);
    await db()
      .insert(schema.ownerPlans)
      .values({ ownerId: ws, plan: "enterprise", grantedBy: "test", updatedAt: NOW });
    expect((await anonymousDataGrantControl(db(), target())).ok).toBe(false);
    await env.DB.prepare("UPDATE workspaces SET policy = ? WHERE id = ?")
      .bind(JSON.stringify({ ...DEFAULT_POLICY, anonymousDataWriters: "allowed" }), ws)
      .run();
    expect(await anonymousDataGrantControl(db(), target())).toMatchObject({
      ok: true,
      value: { owner: { kind: "workspace", name: "Guild" } },
    });
  });

  it("redeems nothing without the beginning browser's nonce, and stops renewing once closed", async () => {
    const issued = await issue();
    if (!issued.ok) throw new Error(issued.code);
    const noNonce = await redeemAnonymousDataGrantCode(db(), {
      code: issued.value.code,
      artifactId: ID,
      nonceHash: null,
      host: HOST,
      enabled: true,
      now: NOW,
    });
    expect(noNonce.ok).toBe(false);
    const live = await redeem(issued.value.code);
    if (!live.ok) throw new Error(live.code);
    await env.DB.prepare("UPDATE artifact_data SET writers = 'signed_in' WHERE artifact_id = ?")
      .bind(ID)
      .run();
    const renewed = await renewAnonymousDataGrant(db(), {
      grantId: live.value.grantId,
      artifactId: ID,
      enabled: true,
      now: NOW + 60_000,
    });
    expect(renewed).toMatchObject({ ok: false, code: "not_found" });
    // A code issued while open no longer redeems once closed.
    await env.DB.prepare("UPDATE artifact_data SET writers = 'anyone' WHERE artifact_id = ?")
      .bind(ID)
      .run();
    const late = await issue({ addressKey: "e".repeat(32) });
    if (!late.ok) throw new Error(late.code);
    await env.DB.prepare("UPDATE artifacts SET access_mode = 'restricted' WHERE id = ?")
      .bind(ID)
      .run();
    expect((await redeem(late.value.code)).ok).toBe(false);
  });
});
