// The owner's logo on an artifact's origin (premium plan P9): `/__portifact/brand/<sha256>`
// answers only image requests, only for the current logo of a servable artifact whose owner's
// brand is shown, with headers that keep it an image that can never run.
import { env } from "cloudflare:test";
import { brandLogoKey } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { png } from "@portifact/domain/testing/images";
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/index.ts";

const ID = "b7d2qm4xab";
const OWNER = "u_brand_owner";
const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
const LOGO = png({ width: 48, height: 24 });
let SHA = "";

const db = () => regionsFromEnv(env).get("default").db;

async function hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

beforeEach(async () => {
  SHA = await hex(LOGO);
  for (const table of ["owner_brands", "owner_plans", "versions", "artifacts"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  await db()
    .insert(schema.artifacts)
    .values({
      id: ID,
      ownerId: OWNER,
      type: "site",
      name: "Plan",
      state: "active",
      accessMode: "restricted",
      currentVersionId: null,
      expiresAt: NOW + 10 * DAY,
    });
  await db()
    .insert(schema.ownerPlans)
    .values({ ownerId: OWNER, plan: "pro", seats: 1, grantedBy: "test", updatedAt: NOW });
  await db().insert(schema.ownerBrands).values({
    ownerId: OWNER,
    name: "Acme",
    logoSha256: SHA,
    logoType: "image/png",
    logoWidth: 48,
    logoHeight: 24,
    logoBytes: LOGO.length,
    updatedAt: NOW,
  });
  await env.ARTIFACTS.put(brandLogoKey(OWNER, SHA), LOGO);
});

const IMAGE = {
  "sec-fetch-dest": "image",
  "sec-fetch-mode": "no-cors",
  "sec-fetch-site": "cross-site",
};

function get(path: string, headers: Record<string, string> = IMAGE, method = "GET") {
  return handle(new Request(`https://${ID}.portifact.dev${path}`, { method, headers }), env, NOW);
}

describe("the brand logo route", () => {
  it("serves the current logo of a protected artifact's owner as an inert image", async () => {
    const response = await get(`/__portifact/brand/${SHA}`);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "image/png",
      "content-length": String(LOGO.length),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      "cache-control": "public, max-age=31536000, immutable",
      "x-robots-tag": "noindex",
      "referrer-policy": "no-referrer",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(LOGO);
    const head = await get(`/__portifact/brand/${SHA}`, IMAGE, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("answers nothing but an image request: no documents, frames or clients without metadata", async () => {
    for (const headers of [
      { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" },
      { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site" },
      { "sec-fetch-dest": "script", "sec-fetch-mode": "no-cors", "sec-fetch-site": "same-site" },
      {},
    ]) {
      const response = await get(`/__portifact/brand/${SHA}`, headers);
      expect(response.status, JSON.stringify(headers)).toBe(404);
      expect(response.headers.get("content-type")).not.toBe("image/png");
    }
  });

  it("answers 404 for another hash, a lapsed plan, a suspended brand or an unservable artifact", async () => {
    expect((await get(`/__portifact/brand/${"f".repeat(64)}`)).status).toBe(404);
    expect((await get("/__portifact/brand/..%2F..%2Fobjects")).status).toBe(404);
    expect((await get(`/__portifact/brand/${SHA}`)).status).toBe(200);

    const sql = (query: string, ...values: unknown[]) =>
      env.DB.prepare(query)
        .bind(...values)
        .run();
    await sql("UPDATE owner_plans SET valid_until = ? WHERE owner_id = ?", NOW - 1, OWNER);
    expect((await get(`/__portifact/brand/${SHA}`)).status).toBe(404);
    await sql("UPDATE owner_plans SET valid_until = NULL WHERE owner_id = ?", OWNER);

    await sql(
      "UPDATE owner_brands SET suspended_at = ?, suspension_reason = 'impersonation' WHERE owner_id = ?",
      NOW,
      OWNER,
    );
    expect((await get(`/__portifact/brand/${SHA}`)).status).toBe(404);
    await sql(
      "UPDATE owner_brands SET suspended_at = NULL, suspension_reason = NULL WHERE owner_id = ?",
      OWNER,
    );

    await sql(
      "UPDATE artifacts SET state = 'suspended', suspension_reason = 'phishing' WHERE id = ?",
      ID,
    );
    expect((await get(`/__portifact/brand/${SHA}`)).status).toBe(404);
  });

  it("answers 404 when the stored object is gone", async () => {
    await env.ARTIFACTS.delete(brandLogoKey(OWNER, SHA));
    expect((await get(`/__portifact/brand/${SHA}`)).status).toBe(404);
  });
});
