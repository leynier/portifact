// The app's part of review mode: POST /api/v1/artifacts/:id/review issues the one-use code the
// viewer's iframe redeems on the artifact origin. apps/content/test/review.test.ts covers the
// artifact origin's part.
import { env } from "cloudflare:workers";
import { REVIEW_SESSION, ReviewStart, ReviewTabStart } from "@portifact/contracts";
import { createDb, schema } from "@portifact/db";
import { hashSecret, redeemReviewHandoff, reviewSessionTag } from "@portifact/services";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { REVIEW_START_LIMIT } from "../src/auth/limits.ts";
import { publishSite, type TokenClient, tokenClient } from "./api-client.ts";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";

const db = () => createDb(env.DB);

function start(
  h: Harness,
  artifactId: string,
  cookie: string,
  extra: Record<string, string> = {},
  path = "review",
) {
  return h.request(`/api/v1/artifacts/${artifactId}/${path}`, {
    method: "POST",
    headers: { cookie, "sec-fetch-site": "same-origin", origin: ORIGIN, ...extra },
  });
}

let h: Harness;
let owner: TokenClient;
let artifactId: string;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_limits");
  await env.DB.exec("DELETE FROM review_handoffs");
  h = createHarness();
  owner = await tokenClient(h, `review-owner-${crypto.randomUUID()}@example.test`);
  artifactId = await publishSite(owner, "Review plan");
});

describe("review codes", () => {
  it("gives the owner a code for the current version, bound to the dashboard session", async () => {
    const response = await start(h, artifactId, owner.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = ReviewStart.parse(await response.json());
    const origin = `https://${artifactId}.portifact.dev`;
    expect(body.origin).toBe(origin);
    expect(body).toMatchObject({
      artifactId,
      name: "Review plan",
      type: "site",
      entrypoint: "index.html",
    });
    const url = new URL(body.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${origin}/__portifact/review`);
    const code = url.searchParams.get("code") ?? "";
    expect(body.sessionTag).toBe(await reviewSessionTag(code));

    const [artifact] = await db()
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    expect(body.versionId).toBe(artifact?.currentVersionId);
    const [row] = await db()
      .select()
      .from(schema.reviewHandoffs)
      .where(eq(schema.reviewHandoffs.codeHash, await hashSecret(code)));
    expect(row).toMatchObject({ artifactId, userId: owner.userId, versionId: body.versionId });
    const [session] = await db()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, owner.userId));
    expect(row?.authSessionId).toBe(session?.id);

    const asTab = await redeemReviewHandoff(db(), {
      code,
      artifactId,
      kind: "tab",
      now: Date.now(),
    });
    expect(asTab.ok).toBe(false);
    const redeemed = await redeemReviewHandoff(db(), {
      code,
      artifactId,
      kind: "frame",
      now: Date.now(),
    });
    expect(redeemed.ok).toBe(true);
  });

  it("answers an account the policy does not admit like a missing artifact", async () => {
    const stranger = await h.signIn(`review-stranger-${crypto.randomUUID()}@example.test`);
    const forbidden = await start(h, artifactId, stranger);
    const missing = await start(h, "zzzzzzzzzz", stranger);
    const malformed = await start(h, "NOT-AN-ID", stranger);
    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await forbidden.json()).toEqual(await missing.json());
  });

  it("refuses bearer tokens, cross-origin requests and requests without a session", async () => {
    const bearer = await owner.call(`/api/v1/artifacts/${artifactId}/review`, { method: "POST" });
    expect(bearer.status).toBe(403);
    const anonymous = await start(h, artifactId, "");
    expect(anonymous.status).toBe(401);
    const sibling = await start(h, artifactId, owner.cookie, {
      "sec-fetch-site": "cross-site",
      origin: `https://${artifactId}.portifact.dev`,
    });
    expect(sibling.status).toBe(403);
    const noOrigin = await h.request(`/api/v1/artifacts/${artifactId}/review`, {
      method: "POST",
      headers: { cookie: owner.cookie, "sec-fetch-site": "same-origin" },
    });
    expect(noOrigin.status).toBe(403);
    const noMetadata = await h.request(`/api/v1/artifacts/${artifactId}/review`, {
      method: "POST",
      headers: { cookie: owner.cookie, origin: ORIGIN },
    });
    expect(noMetadata.status).toBe(403);
    const forged = await start(h, artifactId, "__Host-pf.session_token=forged.value");
    expect(forged.status).toBe(401);
    expect(await db().select().from(schema.reviewHandoffs)).toHaveLength(0);
  });

  it("is not reachable with GET", async () => {
    const response = await h.request(`/api/v1/artifacts/${artifactId}/review`, {
      headers: { cookie: owner.cookie, "sec-fetch-site": "same-origin" },
    });
    expect(response.status).toBe(404);
  });

  it("limits how many codes an account asks for", async () => {
    for (let i = 0; i < REVIEW_START_LIMIT.max; i++) {
      expect((await start(h, artifactId, owner.cookie)).status).toBe(200);
    }
    const limited = await start(h, artifactId, owner.cookie);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
  });

  it("does not issue tab codes with GET", async () => {
    const response = await h.request(`/api/v1/artifacts/${artifactId}/review/tab`, {
      headers: { cookie: owner.cookie, "sec-fetch-site": "same-origin" },
    });
    expect(response.status).toBe(404);
  });
});

describe("review tab codes", () => {
  const startTab = (cookie: string, extra: Record<string, string> = {}, id = artifactId) =>
    start(h, id, cookie, extra, "review/tab");

  it("gives a code that opens only a top-level review tab, with a short session", async () => {
    const response = await startTab(owner.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = ReviewTabStart.parse(await response.json());
    const origin = `https://${artifactId}.portifact.dev`;
    expect(body).toMatchObject({
      artifactId,
      origin,
      sessionSeconds: REVIEW_SESSION.tabSessionTtlSeconds,
    });
    const url = new URL(body.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${origin}/__portifact/review/tab`);
    const code = url.searchParams.get("code") ?? "";
    const [row] = await db()
      .select()
      .from(schema.reviewHandoffs)
      .where(eq(schema.reviewHandoffs.codeHash, await hashSecret(code)));
    expect(row).toMatchObject({ artifactId, userId: owner.userId, kind: "tab" });
    const inFrame = await redeemReviewHandoff(db(), {
      code,
      artifactId,
      kind: "frame",
      now: Date.now(),
    });
    expect(inFrame.ok).toBe(false);
    const inTab = await redeemReviewHandoff(db(), {
      code,
      artifactId,
      kind: "tab",
      now: Date.now(),
    });
    expect(inTab.ok).toBe(true);
  });

  it("applies the same session, origin, access and limit checks as review codes", async () => {
    const bearer = await owner.call(`/api/v1/artifacts/${artifactId}/review/tab`, {
      method: "POST",
    });
    expect(bearer.status).toBe(403);
    expect((await startTab("")).status).toBe(401);
    const sibling = await startTab(owner.cookie, {
      "sec-fetch-site": "cross-site",
      origin: `https://${artifactId}.portifact.dev`,
    });
    expect(sibling.status).toBe(403);
    const stranger = await h.signIn(`review-tab-stranger-${crypto.randomUUID()}@example.test`);
    const forbidden = await startTab(stranger);
    const missing = await startTab(stranger, {}, "zzzzzzzzzz");
    expect(forbidden.status).toBe(404);
    expect(await forbidden.json()).toEqual(await missing.json());
    expect(await db().select().from(schema.reviewHandoffs)).toHaveLength(0);

    // Frame and tab codes share one limit per account.
    for (let i = 0; i < REVIEW_START_LIMIT.max - 1; i++) {
      expect((await start(h, artifactId, owner.cookie)).status).toBe(200);
    }
    expect((await startTab(owner.cookie)).status).toBe(200);
    const limited = await startTab(owner.cookie);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
  });
});
