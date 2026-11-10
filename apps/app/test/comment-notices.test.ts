// The adapters of comment notices on the app Worker: the one-click unsubscribe endpoint, which
// needs no session, and the session-only per-artifact mute and settings.
import { env } from "cloudflare:workers";
import { signUnsubscribeToken } from "@portifact/services";
import { describe, expect, it } from "vitest";
import { UNSUBSCRIBE_LIMIT, UNSUBSCRIBE_PATH } from "../src/api/notices.ts";
import { publishSite, tokenClient } from "./api-client.ts";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";

const SECRET = "test-only-unsubscribe-secret";

function dashboard(cookie: string, method = "GET", body?: unknown): RequestInit {
  return {
    method,
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function settingsOf(h: Harness, cookie: string) {
  const response = await h.request("/api/v1/account/settings", dashboard(cookie));
  return response.json<{ commentNotices: boolean }>();
}

/** A one-click POST as a mail client sends it, from anywhere, without cookies (RFC 8058). */
function oneClick(h: Harness, token: string, ip = "198.51.100.7") {
  return h.request(`${UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": ip,
      origin: "https://mail.example",
    },
    body: "List-Unsubscribe=One-Click",
  });
}

async function resetLimits() {
  await env.DB.exec("DELETE FROM rate_limits");
}

describe("one-click unsubscribe", () => {
  it("turns comment notices off from a mail client's POST, and a GET changes nothing", async () => {
    await resetLimits();
    const h = createHarness();
    const c = await tokenClient(h, "unsubscribe-one-click@example.test");
    const token = await signUnsubscribeToken(SECRET, c.userId, Date.now() - 1_000);

    const prefetched = await h.request(`${UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`);
    expect(prefetched.status).toBe(404);
    expect((await settingsOf(h, c.cookie)).commentNotices).toBe(true);

    const response = await oneClick(h, token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ unsubscribed: true });
    expect((await settingsOf(h, c.cookie)).commentNotices).toBe(false);
    // A second click answers the same.
    expect((await oneClick(h, token)).status).toBe(200);
  });

  it("takes the token as JSON from the unsubscribe page", async () => {
    await resetLimits();
    const h = createHarness();
    const c = await tokenClient(h, "unsubscribe-page@example.test");
    const token = await signUnsubscribeToken(SECRET, c.userId, Date.now() - 1_000);
    const response = await h.request(UNSUBSCRIBE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(200);
    expect((await settingsOf(h, c.cookie)).commentNotices).toBe(false);
  });

  it("refuses a tampered or missing token, and answers an unknown account like a known one", async () => {
    await resetLimits();
    const h = createHarness();
    const token = await signUnsubscribeToken(SECRET, "u_nobody", Date.now() - 1_000);
    expect(await (await oneClick(h, token)).json()).toEqual({ unsubscribed: true });
    const forged = await signUnsubscribeToken("another-secret", "u_nobody", Date.now() - 1_000);
    for (const bad of [forged, "", "not a token"]) {
      const response = await oneClick(h, bad);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_input" } });
    }
    const empty = await h.request(UNSUBSCRIBE_PATH, { method: "POST" });
    expect(empty.status).toBe(400);
    const oversized = await h.request(UNSUBSCRIBE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "a".repeat(2_000) }),
    });
    expect(oversized.status).toBe(400);
    const malformed = await h.request(UNSUBSCRIBE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
  });

  it("limits requests per IP", async () => {
    await resetLimits();
    const h = createHarness();
    for (let i = 0; i < UNSUBSCRIBE_LIMIT.max; i += 1) {
      expect((await oneClick(h, "cn1.x.1.y", "203.0.113.9")).status).toBe(400);
    }
    const limited = await oneClick(h, "cn1.x.1.y", "203.0.113.9");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect((await oneClick(h, "cn1.x.1.y", "203.0.113.10")).status).toBe(400);
  });

  it("answers 503 without the secret", async () => {
    await resetLimits();
    const h = createHarness({ env: { UNSUBSCRIBE_SECRET: undefined } });
    const response = await oneClick(h, "cn1.x.1.y");
    expect(response.status).toBe(503);
  });
});

describe("comment notice preferences", () => {
  it("are a setting of the account, saved through the session", async () => {
    const h = createHarness();
    const c = await tokenClient(h, "notice-settings@example.test");
    const saved = await h.request(
      "/api/v1/account/settings",
      dashboard(c.cookie, "PATCH", { commentNotices: false }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ commentNotices: false, expiryNotices: true });
  });

  it("mutes one artifact for the caller, only through the session", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "notice-mute-owner@example.test");
    const id = await publishSite(owner);
    await env.DB.prepare("update artifacts set annotations = 'open' where id = ?").bind(id).run();
    const path = `/api/v1/account/comment-notices/${id}`;

    const before = await h.request(path, dashboard(owner.cookie));
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ available: false, muted: false });

    await env.DB.prepare(
      "insert into owner_plans (owner_id, plan, seats, granted_by, updated_at) values (?, 'pro', 1, 'test', 0)",
    )
      .bind(owner.userId)
      .run();
    const muted = await h.request(path, dashboard(owner.cookie, "PUT", { muted: true }));
    expect(muted.status).toBe(200);
    expect(await muted.json()).toEqual({ available: true, muted: true });

    const bearer = await owner.call(path);
    expect(bearer.status).toBe(403);
    const invalid = await h.request(path, dashboard(owner.cookie, "PUT", { muted: "yes" }));
    expect(invalid.status).toBe(400);
  });

  it("answers like a missing artifact to someone who cannot read its comments", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "notice-mute-private@example.test");
    const stranger = await tokenClient(h, "notice-mute-stranger@example.test");
    const id = await publishSite(owner);
    for (const target of [id, "aaaaaaaaaa", "not-an-id"]) {
      const response = await h.request(
        `/api/v1/account/comment-notices/${target}`,
        dashboard(stranger.cookie, "PUT", { muted: true }),
      );
      expect(response.status).toBe(404);
    }
  });
});
