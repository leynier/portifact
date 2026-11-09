// The app's part of review mode: POST /api/v1/artifacts/:id/review issues the one-use code the
// viewer's iframe redeems on the artifact origin. apps/content/test/review.test.ts covers the
// artifact origin's part.
import { env } from "cloudflare:workers";
import { REVIEW_SESSION, ReviewStart, ReviewTabStart, ViewerInfo } from "@portifact/contracts";
import { createDb, schema } from "@portifact/db";
import { hashSecret, redeemReviewHandoff, reviewSessionTag } from "@portifact/services";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { REVIEW_START_LIMIT, VIEWER_LOOKUP_LIMIT } from "../src/auth/limits.ts";
import { publishSite, type TokenClient, tokenClient } from "./api-client.ts";
import { createHarness, type Harness, ORIGIN, SESSION_COOKIE } from "./harness.ts";

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

  it("limits how many codes an account asks for one artifact", async () => {
    for (let i = 0; i < REVIEW_START_LIMIT.max; i++) {
      expect((await start(h, artifactId, owner.cookie)).status).toBe(200);
    }
    const limited = await start(h, artifactId, owner.cookie);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
  });

  it("keeps other artifacts open when one artifact's codes are used up", async () => {
    // Any site can reload the viewer of one artifact in a popup; that must not lock the account
    // out of the artifacts it reads.
    const other = await publishSite(owner, "Other plan");
    for (let i = 0; i <= REVIEW_START_LIMIT.max; i++) await start(h, artifactId, owner.cookie);
    expect((await start(h, artifactId, owner.cookie)).status).toBe(429);
    expect((await start(h, other, owner.cookie)).status).toBe(200);
    // At most REVIEW_OPEN_CODES codes stay open per account; older ones are expired.
    const open = await db()
      .select()
      .from(schema.reviewHandoffs)
      .where(eq(schema.reviewHandoffs.userId, owner.userId));
    expect(open.length).toBeLessThanOrEqual(REVIEW_SESSION.openCodesPerUser);
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

describe("viewer info", () => {
  const view = (cookie: string, extra: Record<string, string> = {}, id = artifactId) =>
    h.request(`/api/v1/artifacts/${id}/viewer`, {
      headers: { ...(cookie ? { cookie } : {}), "sec-fetch-site": "same-origin", ...extra },
    });

  it("tells the owner and a signed-in reader what the bar shows, never threads or readers", async () => {
    const response = await view(owner.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(ViewerInfo.parse(await response.json())).toEqual({
      artifactId,
      name: "Review plan",
      type: "site",
      origin: `https://${artifactId}.portifact.dev`,
      versionNumber: 1,
      accessMode: "restricted",
      annotations: "off",
      role: "owner",
    });
    await env.DB.prepare("UPDATE artifacts SET access_mode = 'authenticated' WHERE id = ?")
      .bind(artifactId)
      .run();
    const reader = await h.signIn(`viewer-reader-${crypto.randomUUID()}@example.test`);
    expect(await (await view(reader)).json()).toMatchObject({ role: "reader" });
  });

  it("shows anonymous visitors public artifacts only; anything else looks missing", async () => {
    const hidden = await view("");
    const missing = await view("", {}, "zzzzzzzzzz");
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
    const stranger = await h.signIn(`viewer-stranger-${crypto.randomUUID()}@example.test`);
    expect((await view(stranger)).status).toBe(404);
    await env.DB.prepare("UPDATE artifacts SET access_mode = 'public' WHERE id = ?")
      .bind(artifactId)
      .run();
    expect(await (await view("")).json()).toMatchObject({ role: "anonymous" });
    expect(await (await view(stranger)).json()).toMatchObject({ role: "reader" });
    // A forged session cookie is an anonymous visitor, not an error.
    expect((await view(`${SESSION_COOKIE}=forged.value`)).status).toBe(200);
  });

  it("limits lookups per IP address, with or without a session", async () => {
    const fromIp = (ip: string) => view("", { "cf-connecting-ip": ip });
    for (let i = 0; i < VIEWER_LOOKUP_LIMIT.max; i++) {
      expect((await fromIp("203.0.113.7")).status).toBe(404);
    }
    const limited = await fromIp("203.0.113.7");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect((await view(owner.cookie, { "cf-connecting-ip": "203.0.113.7" })).status).toBe(429);
    expect((await fromIp("203.0.113.8")).status).toBe(404);
  });

  it("answers only the app's own pages: no bearer tokens, no other sites, no bad IDs", async () => {
    const bearer = await owner.call(`/api/v1/artifacts/${artifactId}/viewer`);
    expect(bearer.status).toBe(403);
    for (const site of ["cross-site", "same-site", ""]) {
      const refused = await view(owner.cookie, site ? { "sec-fetch-site": site } : {});
      if (!site) {
        const bare = await h.request(`/api/v1/artifacts/${artifactId}/viewer`, {
          headers: { cookie: owner.cookie },
        });
        expect(bare.status).toBe(403);
        continue;
      }
      expect(refused.status, site).toBe(403);
    }
    expect((await view(owner.cookie, {}, "NOT-AN-ID")).status).toBe(404);
  });
});
