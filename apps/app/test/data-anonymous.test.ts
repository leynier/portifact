// Anonymous grants on the app (decision 0026, delivery 9): the control's facts and the one-use
// code for a visitor without an account. No credentials, same origin only, a solved human check,
// limited per network address and per artifact, off unless both switches are on, and like a
// missing artifact wherever anonymous writing is not open.
import { env } from "cloudflare:workers";
import { DATA_GRANT } from "@portifact/contracts";
import { TERMS_VERSION } from "@portifact/contracts/terms-version";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addressKey } from "../src/api/data-anonymous.ts";
import { publishSite, tokenClient } from "./api-client.ts";
import { createHarness, FAILED_HUMAN_TOKEN, type Harness, HUMAN_TOKEN, ORIGIN } from "./harness.ts";

const NONCE_HASH = "n".repeat(43);
const ON = {
  ARTIFACT_DATA_ENABLED: "true",
  DATA_PAGE_WRITES_ENABLED: "true",
  DATA_ANONYMOUS_ENABLED: "true",
};
const db = () => regionsFromEnv(env).get("default").db;

let tokens = 0;
const solved = () => `${HUMAN_TOKEN}-anon-${++tokens}-${crypto.randomUUID()}`;

function page(method = "GET", body?: unknown, ip = "203.0.113.7"): RequestInit {
  return {
    method,
    headers: {
      "sec-fetch-site": "same-origin",
      "cf-connecting-ip": ip,
      ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** A public artifact with data whose owner chose who writes. */
async function openArtifact(h: Harness, owner: string, writers: "anyone" | "signed_in" = "anyone") {
  const id = await publishSite(await tokenClient(h, owner), "Guestbook");
  await db()
    .update(schema.artifacts)
    .set({ accessMode: "public" })
    .where(eq(schema.artifacts.id, id));
  await db().insert(schema.artifactData).values({ artifactId: id, writers, updatedAt: Date.now() });
  return id;
}

const issue = (h: Harness, id: string, token = solved(), ip?: string) =>
  h.request(
    "/api/v1/data/anonymous-grants",
    page(
      "POST",
      {
        artifactId: id,
        nonceHash: NONCE_HASH,
        flow: "top",
        turnstileToken: token,
        termsVersion: TERMS_VERSION,
      },
      ip,
    ),
  );

const grantsOf = (id: string) =>
  db()
    .select()
    .from(schema.dataAnonymousGrants)
    .where(eq(schema.dataAnonymousGrants.artifactId, id));

describe("anonymous grants on the app", () => {
  it("answers 404 unless artifact data and anonymous writing are both on", async () => {
    for (const off of [
      { ...ON, DATA_ANONYMOUS_ENABLED: "false" },
      { ...ON, ARTIFACT_DATA_ENABLED: "false" },
    ]) {
      const h = createHarness({ env: off });
      const control = await h.request("/api/v1/data/anonymous-grants/k7d2qm4xab/control", page());
      expect(control.status).toBe(404);
      expect((await issue(h, "k7d2qm4xab")).status).toBe(404);
    }
  });

  it("draws the control and issues a code that names the anonymous redemption", async () => {
    const h = createHarness({ env: ON });
    const id = await openArtifact(h, "anon-owner@example.test");
    const control = await h.request(`/api/v1/data/anonymous-grants/${id}/control`, page());
    expect(control.status).toBe(200);
    expect(await control.json()).toEqual({
      artifactId: id,
      artifactName: "Guestbook",
      host: `${id}.${env.CONTENT_DOMAIN}`,
      owner: { kind: "user", name: expect.any(String) },
      grantDays: DATA_GRANT.anonymousGrantTtlSeconds / 86_400,
    });
    const issued = await issue(h, id);
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const { code, redeemUrl } = await issued.json<{ code: string; redeemUrl: string }>();
    const url = new URL(redeemUrl);
    expect(url.origin).toBe(`https://${id}.${env.CONTENT_DOMAIN}`);
    expect(url.pathname).toBe("/__portifact/data/grant");
    expect(url.searchParams.get("anon")).toBe("1");
    expect(url.searchParams.get("code")).toBe(code);
    const [row] = await grantsOf(id);
    // Only hashes are kept, and nothing names the visitor or their address.
    expect(row?.codeHash).not.toBe(code);
    expect(JSON.stringify(row)).not.toContain("203.0.113.7");
    expect(row?.visitorId).toMatch(/^v_/);
    expect(row?.usedAt).toBeNull();
    expect(h.siteverifyCalls.at(-1)?.remoteIp).toBe("203.0.113.7");
  });

  it("refuses another site, a missing or failed human check, and paused page writes", async () => {
    const h = createHarness({ env: ON });
    const id = await openArtifact(h, "anon-refuse@example.test");
    const crossSite = await h.request("/api/v1/data/anonymous-grants", {
      method: "POST",
      headers: {
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        artifactId: id,
        nonceHash: NONCE_HASH,
        flow: "top",
        turnstileToken: solved(),
        termsVersion: TERMS_VERSION,
      }),
    });
    expect(crossSite.status).toBe(403);
    const noMetadata = await h.request(`/api/v1/data/anonymous-grants/${id}/control`, {});
    expect(noMetadata.status).toBe(403);
    const failed = await issue(h, id, FAILED_HUMAN_TOKEN);
    expect(failed.status).toBe(403);
    expect(await failed.json()).toMatchObject({ error: { code: "human_verification_required" } });
    const missing = await h.request(
      "/api/v1/data/anonymous-grants",
      page("POST", { artifactId: id, nonceHash: NONCE_HASH, flow: "top" }),
    );
    expect(missing.status).toBe(400);
    const paused = createHarness({ env: { ...ON, DATA_PAGE_WRITES_ENABLED: "false" } });
    expect((await issue(paused, id)).status).toBe(503);
    expect(await grantsOf(id)).toEqual([]);
  });

  it("answers like a missing artifact where anonymous writing is not open", async () => {
    const h = createHarness({ env: ON });
    const signedInOnly = await openArtifact(h, "anon-closed@example.test", "signed_in");
    const restricted = await openArtifact(h, "anon-restricted@example.test");
    await db()
      .update(schema.artifacts)
      .set({ accessMode: "restricted" })
      .where(eq(schema.artifacts.id, restricted));
    const noData = await publishSite(await tokenClient(h, "anon-nodata@example.test"), "Plain");
    await db()
      .update(schema.artifacts)
      .set({ accessMode: "public" })
      .where(eq(schema.artifacts.id, noData));
    const answers = new Set<string>();
    for (const id of [signedInOnly, restricted, noData, "k7d2qm4xab"]) {
      const control = await h.request(`/api/v1/data/anonymous-grants/${id}/control`, page());
      expect(control.status, id).toBe(404);
      answers.add(await control.text());
      const issued = await issue(h, id);
      expect(issued.status, id).toBe(404);
      answers.add(await issued.text());
    }
    expect(answers.size).toBe(1);
  });

  it("refuses an Allow made under terms that are no longer current", async () => {
    const h = createHarness({ env: ON });
    const id = await openArtifact(h, "anon-terms@example.test");
    const stale = await h.request(
      "/api/v1/data/anonymous-grants",
      page("POST", {
        artifactId: id,
        nonceHash: NONCE_HASH,
        flow: "top",
        turnstileToken: solved(),
        termsVersion: "2020-01-01",
      }),
    );
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      "terms_not_accepted",
    );
    // A prompt from before the version was sent at all is refused as malformed.
    const missing = await h.request(
      "/api/v1/data/anonymous-grants",
      page("POST", {
        artifactId: id,
        nonceHash: NONCE_HASH,
        flow: "top",
        turnstileToken: solved(),
      }),
    );
    expect(missing.status).toBe(400);
    expect(await grantsOf(id)).toHaveLength(0);
  });

  it("limits codes per network address", async () => {
    const h = createHarness({ env: ON });
    const id = await openArtifact(h, "anon-limit@example.test");
    for (let i = 0; i < DATA_GRANT.anonymousPerIpPerHour; i++) {
      expect((await issue(h, id, solved(), "198.51.100.9")).status).toBe(200);
    }
    expect((await issue(h, id, solved(), "198.51.100.9")).status).toBe(429);
    // Another address is not held back by it.
    expect((await issue(h, id, solved(), "198.51.100.10")).status).toBe(200);
  });

  it("keys the per-address limit by a secret HMAC of the address, never the address", async () => {
    const h = createHarness({ env: ON });
    const id = await openArtifact(h, "anon-key@example.test");
    expect((await issue(h, id, solved(), "192.0.2.77")).status).toBe(200);
    const unkeyed = [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode("192.0.2.77")),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const { results } = await env.DB.prepare(
      "select key from rate_limits where key like 'data_anon:ip:%'",
    ).all<{ key: string }>();
    const keys = results.map((row) => row.key);
    const expected = `data_anon:ip:${await addressKey(env.BETTER_AUTH_SECRET, "192.0.2.77")}`;
    expect(keys).toContain(expected);
    expect(keys.some((key) => key.includes("192.0.2.77"))).toBe(false);
    expect(keys.some((key) => unkeyed.startsWith(key.slice("data_anon:ip:".length)))).toBe(false);
  });
});

describe("addressKey", () => {
  it("is a stable HMAC per secret, normalized, and differs across secrets", async () => {
    const one = await addressKey("secret-one", "2001:DB8::1");
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(await addressKey("secret-one", " 2001:db8::1 ")).toBe(one);
    expect(await addressKey("secret-two", "2001:db8::1")).not.toBe(one);
    expect(await addressKey("secret-one", "2001:db8::2")).not.toBe(one);
    expect(await addressKey("secret-one", null)).toBe(await addressKey("secret-one", "unknown"));
  });
});
