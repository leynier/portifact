// Review mode on the artifact origin. The app's part (checking the account and issuing the code)
// is played by `issueReviewHandoff`, the same service the app's route calls;
// apps/app/test/review.test.ts covers that route.
import { env } from "cloudflare:test";
import { BRIDGE_VERSION } from "@portifact/bridge/bundle";
import { REVIEW_SESSION, type ReviewKind } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { RENDERER_VERSION } from "@portifact/render";
import { DIAGRAM_VERSION } from "@portifact/render/diagrams-version";
import { DIAGRAM_LOADER_HASH } from "@portifact/render/policy";
import {
  commitPublish,
  issueReviewHandoff,
  preparePublish,
  reviewSessionTag,
} from "@portifact/services";
import { beforeEach, describe, expect, it } from "vitest";
import type { LogOpening, Opening } from "../src/access-log.ts";
import { handle } from "../src/index.ts";
import { BANNER_TEXT, injectReviewBanner } from "../src/inject.ts";
import { REVIEW_COOKIE, REVIEW_TAB_COOKIE } from "../src/review.ts";
import { NO_BAR_COOKIE } from "../src/viewer.ts";
import type { CountView, ViewCharge } from "../src/views.ts";

const ID = "r7d2qm4xab";
const OTHER_ID = "r3n5wq7yzc";
const ORIGIN = `https://${ID}.portifact.dev`;
const APP = "https://app.portifact.com";
const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
const CLAIMS_MS = REVIEW_SESSION.claimsTtlSeconds * 1000;
const SESSION_MS = REVIEW_SESSION.sessionTtlSeconds * 1000;
const PAGE =
  "<!doctype html><html><head><title>Plan</title></head><body><h1>Plan</h1></body></html>";
const SCRIPT = "console.log('app')";
const db = () => regionsFromEnv(env).get("default").db;

const OWNER = "rv_owner";
const READER = "rv_reader";
const appSession = (userId: string) => `rvs_${userId}`;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function seed(overrides: Partial<typeof schema.artifacts.$inferInsert> = {}) {
  for (const table of [
    "traffic_counters",
    "review_sessions",
    "review_handoffs",
    "read_sessions",
    "read_handoffs",
    "artifact_readers",
    "version_files",
    "versions",
    "objects",
    "upload_sessions",
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
        { id: OWNER, email: "owner@example.com" },
        { id: READER, email: "reader@example.com" },
      ].map((user) => ({
        ...user,
        name: user.id,
        emailVerified: true,
        createdAt: at,
        updatedAt: at,
      })),
    );
  await db()
    .insert(schema.sessions)
    .values(
      [OWNER, READER].map((userId) => ({
        id: appSession(userId),
        token: `token-${userId}`,
        userId,
        expiresAt: new Date(NOW + 7 * DAY),
        createdAt: at,
        updatedAt: at,
      })),
    );
  const files = { "index.html": PAGE, "app.js": SCRIPT };
  for (const body of Object.values(files)) {
    const hash = await sha256(body);
    await env.ARTIFACTS.put(`objects/${OWNER}/${hash}`, body);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO objects (owner_id, sha256, size, r2_key, state) VALUES (?, ?, ?, ?, 'verified')",
    )
      .bind(OWNER, hash, body.length, `objects/${OWNER}/${hash}`)
      .run();
  }
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
        currentVersionId: `${id}-v1`,
        expiresAt: NOW + 10 * DAY,
        ...overrides,
      });
    for (const number of [1, 2]) {
      await db()
        .insert(schema.versions)
        .values({
          id: `${id}-v${number}`,
          artifactId: id,
          number,
          authorId: OWNER,
          state: "committed",
          entrypoint: "index.html",
          publishedBytes: PAGE.length,
        });
      for (const [path, body] of Object.entries(files)) {
        await db()
          .insert(schema.versionFiles)
          .values({
            versionId: `${id}-v${number}`,
            kind: "published",
            path,
            ownerId: OWNER,
            sha256: await sha256(body),
            size: body.length,
            contentType: path.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8",
          });
      }
    }
  }
  await db().insert(schema.artifactReaders).values({ artifactId: ID, email: "reader@example.com" });
}

// What browsers send, per docs/decisions/0002-review-mode-cookies.md.
const VIEWER_FRAME = {
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "iframe",
};
const SAME_ORIGIN = {
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Dest": "script",
};
const IN_FRAME_LINK = {
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "iframe",
};
const SIBLING = {
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Dest": "script",
};
const SIBLING_NAVIGATION = {
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "iframe",
};
const TOP_LEVEL = {
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};

interface Send {
  headers?: Record<string, string>;
  cookie?: string | undefined;
  now?: number;
  origin?: string;
  method?: string;
  secret?: string | undefined;
  /** Receives the openings the request records in the owner's access log. */
  logOpening?: LogOpening;
  /** Receives the page views the request counts for the owner's analytics. */
  countView?: CountView;
}

function send(path: string, options: Send = {}) {
  const headers = new Headers(options.headers ?? VIEWER_FRAME);
  if (options.cookie) headers.set("Cookie", options.cookie);
  const request = new Request(`${options.origin ?? ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
  });
  const testEnv = "secret" in options ? { ...env, READ_SESSION_SECRET: options.secret } : env;
  return handle(
    request,
    testEnv,
    options.now ?? NOW,
    undefined,
    options.logOpening,
    options.countView,
  );
}

function reviewSetCookie(response: Response): string | undefined {
  return response.headers.getSetCookie().find((c) => c.startsWith(`${REVIEW_COOKIE}=`));
}

async function code(userId = READER, artifactId = ID, kind?: ReviewKind): Promise<string> {
  const issued = await issueReviewHandoff(db(), {
    artifactId,
    userId,
    authSessionId: appSession(userId),
    now: NOW,
    ...(kind ? { kind } : {}),
    contentDomain: "portifact.dev",
  });
  if (!issued.ok) throw new Error(issued.message);
  return issued.value.code;
}

/** Opens review in the viewer's iframe and returns the review cookie as `name=value`. */
async function openReview(userId = READER, artifactId = ID, issued?: string): Promise<string> {
  const origin = `https://${artifactId}.portifact.dev`;
  const response = await send(
    `/__portifact/review?code=${issued ?? (await code(userId, artifactId))}`,
    { origin },
  );
  expect(response.status).toBe(303);
  const cookie = reviewSetCookie(response);
  if (!cookie) throw new Error("no review cookie");
  return cookie.split(";")[0] ?? "";
}

/** The fixed message a status page posts, and where to. */
function postedStatus(html: string): { status: string; target: string } | null {
  const match = /postMessage\((\{.*?\}), ("[^"]+")\)/.exec(html);
  if (!match) return null;
  const message = JSON.parse(match[1] as string) as { type: string; status: string };
  return { status: message.status, target: JSON.parse(match[2] as string) as string };
}

beforeEach(() => seed());

describe("review exchange", () => {
  it("sets a partitioned, host-only review cookie and checks that it came back", async () => {
    const response = await send(`/__portifact/review?code=${await code()}`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/__portifact/review/check`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const cookie = reviewSetCookie(response) ?? "";
    const attributes = cookie.split("; ").slice(1);
    expect(attributes).toEqual([
      `Max-Age=${SESSION_MS / 1000}`,
      "Path=/",
      "Secure",
      "HttpOnly",
      "SameSite=None",
      "Partitioned",
    ]);
    expect(cookie).not.toMatch(/Domain=/i);

    const check = await send("/__portifact/review/check", { cookie: cookie.split(";")[0] });
    expect(check.status).toBe(303);
    expect(check.headers.get("location")).toBe(`${ORIGIN}/`);
  });

  it("tells the viewer, at its exact origin, when the browser dropped the cookie", async () => {
    const check = await send("/__portifact/review/check");
    expect(check.status).toBe(409);
    expect(postedStatus(await check.text())).toEqual({ status: "unavailable", target: APP });
    const csp = check.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/^default-src 'none'; script-src 'nonce-[A-Za-z0-9+/=]+';/);
    expect(csp).toContain(`frame-ancestors ${APP}`);
    expect(check.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("redeems a code once; a replay gets the failure page and no cookie", async () => {
    const used = await code();
    await send(`/__portifact/review?code=${used}`);
    const replay = await send(`/__portifact/review?code=${used}`);
    expect(replay.status).toBe(400);
    expect(reviewSetCookie(replay)).toBeUndefined();
    expect(postedStatus(await replay.text())).toEqual({ status: "failed", target: APP });
  });

  it("refuses anything but the viewer's iframe navigation, and keeps the code usable", async () => {
    const pending = await code();
    for (const headers of [
      TOP_LEVEL,
      SIBLING_NAVIGATION,
      IN_FRAME_LINK,
      {
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
      { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "iframe" },
      {},
    ]) {
      const refused = await send(`/__portifact/review?code=${pending}`, { headers });
      expect(refused.status).toBe(400);
      expect(reviewSetCookie(refused)).toBeUndefined();
    }
    const response = await send(`/__portifact/review?code=${pending}`);
    expect(response.status).toBe(303);
  });

  it("refuses a code of another artifact and malformed codes", async () => {
    const other = await code(READER, ID);
    const elsewhere = await send(`/__portifact/review?code=${other}`, {
      origin: `https://${OTHER_ID}.portifact.dev`,
    });
    expect(elsewhere.status).toBe(400);
    for (const query of ["", "?code=short", `?code=${other}&code=${other}`]) {
      expect((await send(`/__portifact/review${query}`)).status).toBe(400);
    }
  });

  it("is unavailable without the signing secret", async () => {
    const response = await send(`/__portifact/review?code=${await code()}`, { secret: undefined });
    expect(response.status).toBe(503);
    expect((await send("/__portifact/review/check", { secret: "short" })).status).toBe(503);
  });
});

describe("review delivery", () => {
  it("serves the pinned version with the bridge to the viewer's iframe", async () => {
    const cookie = await openReview();
    const response = await send("/", { cookie });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html.startsWith(PAGE)).toBe(true);
    expect(html).toMatch(
      new RegExp(
        `<script src="/__portifact/bridge\\.js\\?v=${BRIDGE_VERSION}" data-app-origin="${APP}" data-path="index\\.html" data-session-tag="[A-Za-z0-9_-]{22}"></script>$`,
      ),
    );
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toBe(`frame-ancestors 'self' ${APP}`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("records the reviewer's page loads in the access log, not the page's subresources", async () => {
    const cookie = await openReview();
    const openings: Opening[] = [];
    const logOpening = (opening: Opening) => openings.push(opening);
    expect((await send("/", { cookie, logOpening })).status).toBe(200);
    expect((await send("/app.js", { cookie, headers: SAME_ORIGIN, logOpening })).status).toBe(200);
    expect(openings).toEqual([{ artifactId: ID, userId: READER, at: NOW }]);
    // The owner reviewing their own artifact is not a visitor.
    const own = await openReview(OWNER);
    expect((await send("/", { cookie: own, logOpening })).status).toBe(200);
    expect(openings).toHaveLength(1);
  });

  it("counts the reviewer's frame load as a signed-in view on a plan with analytics, never the owner's", async () => {
    await env.DB.exec("DELETE FROM owner_plans");
    await db()
      .insert(schema.ownerPlans)
      .values({ ownerId: OWNER, plan: "pro", seats: 1, grantedBy: "test", updatedAt: NOW });
    try {
      const views: ViewCharge[] = [];
      const countView = (view: ViewCharge) => views.push(view);
      const cookie = await openReview();
      expect((await send("/", { cookie, countView })).status).toBe(200);
      expect((await send("/app.js", { cookie, headers: SAME_ORIGIN, countView })).status).toBe(200);
      expect(
        (await send("/", { cookie, headers: SIBLING_NAVIGATION, countView })).status,
      ).toBeLessThan(500);
      expect(views).toEqual([
        {
          artifactId: ID,
          ownerId: OWNER,
          at: NOW,
          visitorId: READER,
          expiresAt: expect.any(Number),
        },
      ]);
      const own = await openReview(OWNER);
      expect((await send("/", { cookie: own, countView })).status).toBe(200);
      expect(views).toHaveLength(1);
    } finally {
      await env.DB.exec("DELETE FROM owner_plans");
    }
  });

  it("answers 429 in review mode too once the owner's traffic is used up, and charges the page", async () => {
    const cookie = await openReview();
    const charges: unknown[] = [];
    const request = new Request(`${ORIGIN}/`, { headers: { ...VIEWER_FRAME, Cookie: cookie } });
    expect((await handle(request, env, NOW, (charge) => charges.push(charge))).status).toBe(200);
    expect(charges).toEqual([
      { ownerId: OWNER, cycleStart: Date.UTC(2026, 10, 1), bytes: PAGE.length },
    ]);
    await db()
      .insert(schema.trafficCounters)
      .values({
        ownerId: OWNER,
        cycleStart: Date.UTC(2026, 10, 1),
        requests: 1_000_000,
        bytes: 0,
        updatedAt: NOW,
      });
    const response = await send("/", { cookie });
    expect(response.status).toBe(429);
    expect(response.headers.get("portifact-error")).toBe("traffic_exceeded");
  });

  it("tags the page with the session it was served in, so the viewer can spot a planted one", async () => {
    const mine = await code();
    const planted = await code();
    const tagOf = async (cookie: string) =>
      /data-session-tag="([^"]+)"/.exec(await (await send("/", { cookie })).text())?.[1];
    const cookie = await openReview(READER, ID, mine);
    expect(await tagOf(cookie)).toBe(await reviewSessionTag(mine));
    // Another code redeemed in the same partition, for example through a cross-site redirect
    // that a framed artifact started, replaces the cookie; the tag tells the viewer.
    const replaced = await openReview(READER, ID, planted);
    expect(await tagOf(replaced)).toBe(await reviewSessionTag(planted));
    expect(await tagOf(replaced)).not.toBe(await reviewSessionTag(mine));
    // Renewed claims keep the tag.
    const renewed = await send("/", { cookie: replaced, now: NOW + CLAIMS_MS + 1 });
    expect(/data-session-tag="([^"]+)"/.exec(await renewed.text())?.[1]).toBe(
      await reviewSessionTag(planted),
    );
  });

  it("serves the artifact's own subresources and in-frame links in review mode", async () => {
    const cookie = await openReview();
    const script = await send("/app.js", { cookie, headers: SAME_ORIGIN });
    expect(script.status).toBe(200);
    expect(await script.text()).toBe(SCRIPT);
    expect(script.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const link = await send("/index.html", { cookie, headers: IN_FRAME_LINK });
    expect(await link.text()).toContain("/__portifact/bridge.js");
    const head = await send("/", { cookie, method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("never honors the cookie for a sibling artifact, even a public one", async () => {
    const cookie = await openReview();
    const sibling = await send("/app.js", { cookie, headers: SIBLING });
    expect(sibling.status).toBe(401);
    expect(await sibling.text()).not.toContain(SCRIPT);

    await env.DB.exec(`UPDATE artifacts SET access_mode = 'public', embeddable = 1`);
    const publicSibling = await send("/", { cookie, headers: SIBLING_NAVIGATION });
    const html = await publicSibling.text();
    expect(html).toBe(PAGE);
    expect(publicSibling.headers.get("content-security-policy")).toBe("frame-ancestors *");
  });

  it("does not use the cookie for top-level visits or requests without fetch metadata", async () => {
    const cookie = await openReview();
    const visit = await send("/", { cookie, headers: TOP_LEVEL });
    expect(visit.status).toBe(303);
    expect(visit.headers.get("location")).toMatch(/^https:\/\/app\.portifact\.com\/read\//);
    const bare = await send("/", { cookie, headers: {} });
    expect(bare.status).toBe(401);
    expect(await bare.text()).not.toContain("bridge.js");
  });

  it("keeps review responses unembeddable and noindex even when the artifact allows both", async () => {
    await env.DB.exec(`UPDATE artifacts SET access_mode = 'public', embeddable = 1, indexable = 1`);
    const cookie = await openReview();
    const response = await send("/", { cookie });
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("content-security-policy")).toBe(`frame-ancestors 'self' ${APP}`);
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("keeps the review session through hundreds of injected cookies and never clears it", async () => {
    const cookie = await openReview();
    const injected = Array.from({ length: 300 }, (_, index) => `inj${index}=${"x".repeat(60)}`);
    const response = await send("/", { cookie: [...injected, cookie].join("; ") });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("bridge");
    const setCookies = response.headers.getSetCookie();
    expect(setCookies.length).toBeGreaterThan(0);
    expect(setCookies.some((set) => set.startsWith(REVIEW_COOKIE))).toBe(false);
    for (const set of setCookies)
      expect(set).toMatch(/^inj\d+=; Max-Age=0; Domain=portifact\.dev;/);
  });

  it("matches the cookie name exactly and ignores a duplicated or foreign cookie", async () => {
    const cookie = await openReview();
    const value = cookie.slice(REVIEW_COOKIE.length + 1);
    const lower = await send("/app.js", {
      cookie: `__host-pf_review=${value}`,
      headers: SAME_ORIGIN,
    });
    expect(lower.status).toBe(401);
    const doubled = await send("/app.js", {
      cookie: `${cookie}; ${REVIEW_COOKIE}=${value}`,
      headers: SAME_ORIGIN,
    });
    expect(doubled.status).toBe(401);
    const otherCookie = await openReview(READER, OTHER_ID).catch(() => null);
    expect(otherCookie).toBeNull();
    const forged = await send("/app.js", {
      cookie: `${REVIEW_COOKIE}=e30.e30`,
      headers: SAME_ORIGIN,
    });
    expect(forged.status).toBe(401);
  });

  it("ignores a review cookie of another artifact", async () => {
    const cookie = await openReview(OWNER, OTHER_ID);
    const response = await send("/app.js", { cookie, headers: SAME_ORIGIN });
    expect(response.status).toBe(401);
  });
});

describe("review sessions over time", () => {
  it("renews claims after they expire while access holds", async () => {
    const cookie = await openReview();
    const later = await send("/", { cookie, now: NOW + CLAIMS_MS + 1 });
    expect(later.status).toBe(200);
    const renewed = reviewSetCookie(later) ?? "";
    expect(renewed).toContain("Partitioned");
    expect(renewed).toContain(`Max-Age=${Math.floor((SESSION_MS - CLAIMS_MS - 1) / 1000)}`);
  });

  it("ends review within the claims' lifetime after access is revoked", async () => {
    const cookie = await openReview();
    await env.DB.exec("DELETE FROM artifact_readers");
    expect((await send("/", { cookie, now: NOW + 1000 })).status).toBe(200);
    const after = await send("/", { cookie, now: NOW + CLAIMS_MS + 1 });
    expect(after.status).toBe(401);
    expect(postedStatus(await after.text())).toEqual({ status: "ended", target: APP });
    const cleared = reviewSetCookie(after) ?? "";
    expect(cleared).toMatch(/^__Host-pf_review=; Max-Age=0; .*Partitioned$/);
  });

  it("ends review at once when the access policy changes", async () => {
    const cookie = await openReview();
    await env.DB.exec("DELETE FROM artifact_readers");
    await env.DB.exec("UPDATE artifacts SET policy_generation = policy_generation + 1");
    const response = await send("/", { cookie, now: NOW + 1000 });
    expect(response.status).toBe(401);
  });

  it("ends review when a new version is published or the app session ends", async () => {
    const cookie = await openReview();
    await env.DB.exec(`UPDATE artifacts SET current_version_id = '${ID}-v2' WHERE id = '${ID}'`);
    const moved = await send("/", { cookie, now: NOW + 1000 });
    expect(postedStatus(await moved.text())?.status).toBe("ended");

    await seed();
    const second = await openReview();
    await env.DB.exec(`DELETE FROM sessions WHERE user_id = '${READER}'`);
    const signedOut = await send("/", { cookie: second, now: NOW + CLAIMS_MS + 1 });
    expect(signedOut.status).toBe(401);
  });

  it("ends review when the artifact is archived", async () => {
    const cookie = await openReview();
    await env.DB.exec(`UPDATE artifacts SET state = 'archived', archived_at = ${NOW}`);
    const response = await send("/", { cookie, now: NOW + 1000 });
    expect(postedStatus(await response.text())?.status).toBe("ended");
  });

  it("ignores the cookie when review cannot be verified without the secret", async () => {
    const cookie = await openReview();
    const response = await send("/app.js", { cookie, headers: SAME_ORIGIN, secret: undefined });
    expect(response.status).toBe(503);
  });
});

describe("bridge script", () => {
  it("serves the bundle as an immutable script for its own version", async () => {
    const response = await send(`/__portifact/bridge.js?v=${BRIDGE_VERSION}`, {
      headers: SAME_ORIGIN,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect((await response.text()).length).toBeGreaterThan(1000);
    const stale = await send("/__portifact/bridge.js?v=old", {
      headers: SAME_ORIGIN,
      method: "HEAD",
    });
    expect(stale.headers.get("cache-control")).toBe("no-cache");
    expect(await stale.text()).toBe("");
  });
});

describe("review of rendered documents", () => {
  async function publishMarkdown(): Promise<string> {
    const source = "# Notes\n\nFirst paragraph.";
    const hash = await sha256(source);
    const prepared = await preparePublish(db(), {
      userId: OWNER,
      type: "markdown",
      name: "Notes",
      entrypoint: "notes.md",
      baseVersionId: null,
      files: [
        {
          path: "notes.md",
          kind: "published",
          sha256: hash,
          size: new TextEncoder().encode(source).byteLength,
          contentType: "text/markdown",
        },
      ],
      now: NOW,
    });
    if (!prepared.ok) throw new Error(prepared.message);
    await env.ARTIFACTS.put(`objects/${OWNER}/${hash}`, source, { sha256: hash });
    const committed = await commitPublish(db(), env.ARTIFACTS, {
      userId: OWNER,
      sessionId: prepared.value.sessionId,
      now: NOW,
    });
    if (!committed.ok) throw new Error(committed.message);
    return committed.value.artifactId;
  }

  it("replaces the page's policy with one that adds only the bridge, by nonce", async () => {
    const id = await publishMarkdown();
    const cookie = await openReview(OWNER, id);
    const origin = `https://${id}.portifact.dev`;
    const response = await send("/", { cookie, origin });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toMatch(/http-equiv="Content-Security-Policy"/i);
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = /^[^,]*script-src [^;]*'nonce-([^']+)'/.exec(csp)?.[1];
    expect(csp).toContain(
      `script-src ${DIAGRAM_LOADER_HASH} ${origin}/__portifact/diagrams.js ${origin}/__portifact/diagrams.${DIAGRAM_VERSION}.js 'nonce-`,
    );
    expect(nonce).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`frame-ancestors 'self' ${APP}`);
    expect(html).toMatch(
      new RegExp(
        `data-path="notes\\.md" data-session-tag="[A-Za-z0-9_-]{22}" data-renderer="portifact-render@${RENDERER_VERSION}" nonce="${nonce?.replace(/[+/=]/g, "\\$&")}"`,
      ),
    );
    expect(html.match(/<script/g)).toHaveLength(1);
    // The page's report link would navigate the frame away; the viewer shows its own.
    expect(html).not.toContain("data-portifact-chrome");
    expect(html).not.toContain("/__portifact/report");

    const original = await send("/notes.md", { cookie, origin, headers: SAME_ORIGIN });
    expect(original.headers.get("content-disposition")).toContain("attachment");
    expect(await original.text()).toBe("# Notes\n\nFirst paragraph.");

    const visitor = await send("/", { origin, headers: TOP_LEVEL });
    expect(visitor.status).toBe(303);
  });

  it("shows a document in a review tab with the banner and its policy intact", async () => {
    const id = await publishMarkdown();
    const origin = `https://${id}.portifact.dev`;
    const opened = await send(`/__portifact/review/tab?code=${await code(OWNER, id, "tab")}`, {
      origin,
      headers: {
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        Referer: `${APP}/`,
      },
    });
    const cookie = (opened.headers.getSetCookie()[0] ?? "").split(";")[0];
    const response = await send("/", {
      cookie,
      origin,
      headers: {
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("End review");
    expect(html).not.toContain("<script");
    expect(html).toMatch(/http-equiv="Content-Security-Policy"/i);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    // Only the diagram loader and its script, never a nonce: the banner needs no script.
    expect(csp).toContain(
      `script-src ${DIAGRAM_LOADER_HASH} ${origin}/__portifact/diagrams.js ${origin}/__portifact/diagrams.${DIAGRAM_VERSION}.js;`,
    );
    expect(csp).not.toContain("nonce");
  });
});

describe("review tab", () => {
  const TAB_SESSION_MS = REVIEW_SESSION.tabSessionTtlSeconds * 1000;
  // The viewer's link: a cross-site top-level navigation that sends the app's origin as Referer.
  const FROM_VIEWER = {
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    Referer: `${APP}/`,
  };
  const IN_TAB_LINK = {
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
  };
  const tabSetCookie = (response: Response) =>
    response.headers.getSetCookie().find((c) => c.startsWith(`${REVIEW_TAB_COOKIE}=`));

  /** Opens a review tab and returns its cookie as `name=value`. */
  async function openTab(userId = READER, artifactId = ID): Promise<string> {
    const origin = `https://${artifactId}.portifact.dev`;
    const response = await send(
      `/__portifact/review/tab?code=${await code(userId, artifactId, "tab")}`,
      { origin, headers: FROM_VIEWER },
    );
    expect(response.status).toBe(303);
    const cookie = tabSetCookie(response);
    if (!cookie) throw new Error("no review tab cookie");
    return cookie.split(";")[0] ?? "";
  }

  it("sets a short, first-party, host-only cookie and checks that it came back", async () => {
    const response = await send(`/__portifact/review/tab?code=${await code(READER, ID, "tab")}`, {
      headers: FROM_VIEWER,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/__portifact/review/tab/check`);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(reviewSetCookie(response)).toBeUndefined();
    const cookie = tabSetCookie(response) ?? "";
    expect(cookie.split("; ").slice(1)).toEqual([
      `Max-Age=${TAB_SESSION_MS / 1000}`,
      "Path=/",
      "Secure",
      "HttpOnly",
      "SameSite=Lax",
    ]);
    expect(cookie).not.toMatch(/Domain=|Partitioned/i);

    const check = await send("/__portifact/review/tab/check", {
      cookie: cookie.split(";")[0],
      headers: FROM_VIEWER,
    });
    expect(check.status).toBe(303);
    expect(check.headers.get("location")).toBe(`${ORIGIN}/`);
    const dropped = await send("/__portifact/review/tab/check", { headers: FROM_VIEWER });
    expect(dropped.status).toBe(409);
  });

  it("redeems only a tab code, only from the app's top-level navigation, and only once", async () => {
    const pending = await code(READER, ID, "tab");
    for (const headers of [
      VIEWER_FRAME,
      TOP_LEVEL,
      IN_TAB_LINK,
      { ...FROM_VIEWER, "Sec-Fetch-Site": "same-site" },
      { ...FROM_VIEWER, "Sec-Fetch-Dest": "iframe" },
      { ...FROM_VIEWER, Referer: `https://${OTHER_ID}.portifact.dev/` },
      { ...FROM_VIEWER, Referer: "https://app.portifact.com.evil.example/" },
      { ...FROM_VIEWER, Referer: "not a url" },
      {
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
      {},
    ]) {
      const refused = await send(`/__portifact/review/tab?code=${pending}`, { headers });
      expect(refused.status).toBe(400);
      expect(tabSetCookie(refused)).toBeUndefined();
    }
    // A frame code cannot open a tab, nor a tab code the frame.
    const frameCode = await code();
    expect(
      (await send(`/__portifact/review/tab?code=${frameCode}`, { headers: FROM_VIEWER })).status,
    ).toBe(400);
    expect((await send(`/__portifact/review?code=${pending}`)).status).toBe(400);

    expect(
      (await send(`/__portifact/review/tab?code=${pending}`, { headers: FROM_VIEWER })).status,
    ).toBe(303);
    const replay = await send(`/__portifact/review/tab?code=${pending}`, { headers: FROM_VIEWER });
    expect(replay.status).toBe(400);
    expect(tabSetCookie(replay)).toBeUndefined();
  });

  it("writes the banner in the browser's language, marked as such", async () => {
    const cookie = await openTab();
    const response = await send("/", {
      cookie,
      headers: { ...TOP_LEVEL, "Accept-Language": "de-AT,de;q=0.9,en;q=0.5" },
    });
    const html = await response.text();
    expect(html).toContain('lang="de" dir="ltr"');
    expect(html).toContain(`<a href="/__portifact/review/end">${BANNER_TEXT.de.end}</a>`);
    expect(html).not.toContain("End review");
  });

  it("serves the pinned version with the banner and no bridge, on the tab's pages and visits", async () => {
    const cookie = await openTab();
    for (const headers of [FROM_VIEWER, IN_TAB_LINK, TOP_LEVEL]) {
      const response = await send("/", { cookie, headers });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('<body><div role="region" aria-label="Portifact review"');
      expect(html).toContain('<template shadowrootmode="open">');
      expect(html).toContain('<a href="/__portifact/review/end">End review</a>');
      expect(html).toContain(`within ${TAB_SESSION_MS / 60_000} minutes`);
      expect(html).not.toContain("bridge.js");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-security-policy")).toBe(`frame-ancestors 'self' ${APP}`);
    }
    const script = await send("/app.js", { cookie, headers: SAME_ORIGIN });
    expect(script.status).toBe(200);
    expect(await script.text()).toBe(SCRIPT);
  });

  it("never honors the tab cookie for a sibling's loads or frames, or without fetch metadata", async () => {
    const cookie = await openTab();
    expect((await send("/app.js", { cookie, headers: SIBLING })).status).toBe(401);
    const framed = await send("/", { cookie, headers: SIBLING_NAVIGATION });
    expect(framed.status).not.toBe(200);
    expect((await send("/", { cookie, headers: VIEWER_FRAME })).status).not.toBe(200);
    expect((await send("/", { cookie, headers: {} })).status).toBe(401);
    // Names match exactly; a frame cookie value is not a tab cookie.
    const value = cookie.slice(REVIEW_TAB_COOKIE.length + 1);
    const lower = await send("/app.js", {
      cookie: `__host-pf_review_tab=${value}`,
      headers: SAME_ORIGIN,
    });
    expect(lower.status).toBe(401);
    const asFrame = await send("/app.js", {
      cookie: `${REVIEW_COOKIE}=${value}`,
      headers: SAME_ORIGIN,
    });
    expect(asFrame.status).toBe(401);
  });

  it("ends the session at once with End review, only from the artifact itself", async () => {
    const cookie = await openTab();
    for (const headers of [SIBLING_NAVIGATION, TOP_LEVEL, FROM_VIEWER, SAME_ORIGIN]) {
      const refused = await send("/__portifact/review/end", { cookie, headers });
      expect(refused.status).toBe(400);
      expect(tabSetCookie(refused)).toBeUndefined();
    }
    const head = await send("/__portifact/review/end", {
      cookie,
      headers: IN_TAB_LINK,
      method: "HEAD",
    });
    expect(head.status).toBe(400);
    expect((await send("/", { cookie, headers: IN_TAB_LINK })).status).toBe(200);

    const end = await send("/__portifact/review/end", { cookie, headers: IN_TAB_LINK });
    expect(end.status).toBe(200);
    expect(await end.text()).toContain("Review ended");
    expect(end.headers.get("cache-control")).toBe("no-store");
    expect(tabSetCookie(end)).toBe(
      `${REVIEW_TAB_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
    expect(await db().select().from(schema.reviewSessions)).toHaveLength(0);
    // Claims still in a copy of the cookie are refused as soon as they need renewing.
    const stale = await send("/", { cookie, headers: IN_TAB_LINK, now: NOW + CLAIMS_MS + 1 });
    expect(stale.status).toBe(401);
    expect(tabSetCookie(stale)).toMatch(/^__Host-pf_review_tab=; Max-Age=0;/);
    // Ending again, or without a session, only clears the cookie.
    const again = await send("/__portifact/review/end", { headers: IN_TAB_LINK });
    expect(again.status).toBe(200);
    expect(tabSetCookie(again)).toMatch(/Max-Age=0/);
  });

  it("ends within the claims' lifetime with the app session, a new version or its expiry", async () => {
    const cookie = await openTab();
    await env.DB.exec(`DELETE FROM sessions WHERE user_id = '${READER}'`);
    const signedOut = await send("/", { cookie, headers: IN_TAB_LINK, now: NOW + CLAIMS_MS + 1 });
    expect(signedOut.status).toBe(401);
    expect(await signedOut.text()).not.toContain("End review");

    await seed();
    const moved = await openTab();
    await env.DB.exec(`UPDATE artifacts SET current_version_id = '${ID}-v2' WHERE id = '${ID}'`);
    expect((await send("/", { cookie: moved, headers: IN_TAB_LINK })).status).toBe(401);

    await seed();
    const expiring = await openTab();
    const late = await send("/", {
      cookie: expiring,
      headers: IN_TAB_LINK,
      now: NOW + TAB_SESSION_MS + 1,
    });
    expect(late.status).not.toBe(200);
    expect(await late.text()).not.toContain("End review");
  });

  const clearsFrameCookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .includes(
        `${REVIEW_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`,
      );

  it("never honors a frame cookie on a top-level page, and clears it there", async () => {
    // A frame session planted in the artifact's own partition: a sibling framed a redirector to
    // the exchange, which arrived as the cross-site iframe navigation the viewer's does.
    const planted = await openReview();
    for (const headers of [
      TOP_LEVEL,
      FROM_VIEWER,
      IN_TAB_LINK,
      { ...TOP_LEVEL, "Sec-Fetch-Site": "same-site" },
    ]) {
      const visit = await send("/", { cookie: planted, headers });
      expect(visit.status, JSON.stringify(headers)).not.toBe(200);
      expect(await visit.text()).not.toContain("bridge.js");
      expect(clearsFrameCookie(visit), JSON.stringify(headers)).toBe(true);
    }
    // A public artifact opens in the viewer, or itself without the bar, and the planted cookie
    // still goes.
    await env.DB.exec(`UPDATE artifacts SET access_mode = 'public'`);
    const viewed = await send("/", { cookie: planted, headers: TOP_LEVEL });
    expect(viewed.status).toBe(303);
    expect(viewed.headers.get("location")).toBe(`${APP}/view/${ID}`);
    expect(clearsFrameCookie(viewed)).toBe(true);
    await env.DB.exec("UPDATE artifacts SET bar = 0");
    const open = await send("/", { cookie: planted, headers: TOP_LEVEL });
    expect(open.status).toBe(200);
    expect(await open.text()).toBe(PAGE);
    expect(clearsFrameCookie(open)).toBe(true);
    // The viewer's own frame keeps its cookie and review mode.
    const framed = await send("/", { cookie: planted });
    expect(await framed.text()).toContain("bridge.js");
    expect(clearsFrameCookie(framed)).toBe(false);
    const subresource = await send("/app.js", { cookie: planted, headers: SAME_ORIGIN });
    expect(subresource.status).toBe(200);
    expect(clearsFrameCookie(subresource)).toBe(false);
    // Only that exact name is cleared.
    const other = await send("/", { cookie: "__host-pf_review=x", headers: TOP_LEVEL });
    expect(clearsFrameCookie(other)).toBe(false);
  });

  it("serves the visitor's tab over a planted frame session and clears the planted one", async () => {
    const planted = await openReview(OWNER);
    const tab = await openTab();
    for (const headers of [FROM_VIEWER, IN_TAB_LINK, TOP_LEVEL]) {
      const page = await send("/", { cookie: `${planted}; ${tab}`, headers });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("End review");
      expect(html).not.toContain("bridge.js");
      expect(clearsFrameCookie(page)).toBe(true);
    }
    // Both valid on a subresource: the tab wins there too.
    const both = await send("/", {
      cookie: `${planted}; ${tab}`,
      headers: { ...SAME_ORIGIN, "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate" },
    });
    expect(await both.text()).toContain("End review");
  });

  it("clears a planted frame cookie along with the tab's on End review", async () => {
    const planted = await openReview(OWNER);
    const tab = await openTab();
    const end = await send("/__portifact/review/end", {
      cookie: `${planted}; ${tab}`,
      headers: IN_TAB_LINK,
    });
    expect(end.status).toBe(200);
    expect(clearsFrameCookie(end)).toBe(true);
    expect(tabSetCookie(end)).toMatch(/^__Host-pf_review_tab=; Max-Age=0;/);
  });

  it("adds the banner at the end of a page without a body tag", async () => {
    const page = injectReviewBanner(new Response("<p>Bare page</p>"), 15);
    const html = await page.text();
    expect(html.startsWith('<p>Bare page</p><div role="region"')).toBe(true);
    expect(html.match(/End review/g)).toHaveLength(1);
    const nested = injectReviewBanner(
      new Response("<body><iframe srcdoc='<body>x</body>'></iframe><body></body>"),
      15,
    );
    expect((await nested.text()).match(/End review/g)).toHaveLength(1);
  });

  it("is unavailable without the signing secret", async () => {
    const pending = await code(READER, ID, "tab");
    const response = await send(`/__portifact/review/tab?code=${pending}`, {
      headers: FROM_VIEWER,
      secret: undefined,
    });
    expect(response.status).toBe(503);
    expect(
      (await send("/__portifact/review/end", { headers: IN_TAB_LINK, secret: undefined })).status,
    ).toBe(503);
  });
});

describe("the viewer with the Portifact bar", () => {
  beforeEach(() => seed({ accessMode: "public" }));

  const FROM_APP = {
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    Referer: `${APP}/`,
  };
  const EMBED = {
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "iframe",
  };

  it("sends a top-level visit to a page to the viewer, keeping its path and query", async () => {
    for (const headers of [
      TOP_LEVEL,
      { ...TOP_LEVEL, "Sec-Fetch-Site": "cross-site" },
      { ...TOP_LEVEL, "Sec-Fetch-Site": "same-origin" },
      { ...TOP_LEVEL, "Sec-Fetch-Site": "same-site" },
    ]) {
      const root = await send("/", { headers });
      expect(root.status, JSON.stringify(headers)).toBe(303);
      expect(root.headers.get("location")).toBe(`${APP}/view/${ID}`);
    }
    const page = await send("/index.html?q=a%20b&x=1", { headers: TOP_LEVEL });
    expect(page.status).toBe(303);
    const location = new URL(page.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(`${APP}/view/${ID}`);
    expect(location.searchParams.get("path")).toBe("/index.html?q=a%20b&x=1");
    expect(Object.fromEntries(page.headers)).toMatchObject({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
    });
    expect(page.headers.getSetCookie()).toEqual([]);
    expect(await page.text()).toBe("");
  });

  it("serves the viewer's frame, embeds, subresources and clients without fetch metadata as they are", async () => {
    for (const headers of [VIEWER_FRAME, IN_FRAME_LINK, SIBLING_NAVIGATION, EMBED, {}]) {
      const response = await send("/", { headers });
      expect(response.status, JSON.stringify(headers)).toBe(200);
      expect(await response.text()).toBe(PAGE);
    }
    expect((await send("/app.js", { headers: SAME_ORIGIN })).status).toBe(200);
    // A top-level visit to a file that is not a page (a script, an image, a download) is served.
    const script = await send("/app.js", { headers: TOP_LEVEL });
    expect(script.status).toBe(200);
    expect(await script.text()).toBe(SCRIPT);
    // Only GET navigations are redirected; a missing page stays a 404.
    expect((await send("/", { headers: TOP_LEVEL, method: "HEAD" })).status).toBe(200);
    expect((await send("/missing.html", { headers: TOP_LEVEL })).status).toBe(404);
  });

  it("serves the artifact itself to top-level visits when the owner turned the bar off", async () => {
    await env.DB.exec("UPDATE artifacts SET bar = 0");
    const response = await send("/", { headers: TOP_LEVEL });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAGE);
  });

  it("keeps an embeddable artifact embeddable: other sites' frames get the artifact", async () => {
    await env.DB.exec("UPDATE artifacts SET embeddable = 1");
    const response = await send("/", { headers: EMBED });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors *");
  });

  it("never sends a review tab back to the viewer, which would loop", async () => {
    const response = await send(`/__portifact/review/tab?code=${await code(READER, ID, "tab")}`, {
      headers: FROM_APP,
    });
    expect(response.status).toBe(303);
    const tab = (
      response.headers.getSetCookie().find((c) => c.startsWith(`${REVIEW_TAB_COOKIE}=`)) ?? ""
    ).split(";")[0];
    for (const headers of [TOP_LEVEL, { ...TOP_LEVEL, "Sec-Fetch-Site": "same-origin" }]) {
      const page = await send("/", { cookie: tab, headers });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Review tab.");
    }
    // Reserved paths are never redirected either.
    const end = await send("/__portifact/review/end", {
      cookie: tab,
      headers: { ...TOP_LEVEL, "Sec-Fetch-Site": "same-origin" },
    });
    expect(end.status).toBe(200);
  });

  it("serves a page whose path a viewer link cannot carry instead of a different page", async () => {
    const long = `/index.html?${"q=x&".repeat(600)}`;
    const response = await send(long, { headers: TOP_LEVEL });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAGE);
  });

  it("does not log visits of a public artifact, even in the viewer's frame with a session", async () => {
    const cookie = await openReview();
    const openings: Opening[] = [];
    const logOpening = (opening: Opening) => openings.push(opening);
    expect((await send("/", { cookie, logOpening })).status).toBe(200);
    expect(openings).toEqual([]);
  });

  it("tells caches that every answer depends on the fetch metadata", async () => {
    for (const [path, headers] of [
      ["/", TOP_LEVEL],
      ["/", VIEWER_FRAME],
      ["/app.js", SAME_ORIGIN],
      ["/missing.html", TOP_LEVEL],
    ] as const) {
      const vary = (await send(path, { headers })).headers.get("vary") ?? "";
      expect(vary, `${path} ${JSON.stringify(headers)}`).toContain("Sec-Fetch-Dest");
      expect(vary).toContain("Sec-Fetch-Mode");
      expect(vary).toContain("Sec-Fetch-Site");
    }
  });

  it("opens the artifact without the bar from the viewer's link, for a short while", async () => {
    const response = await send("/__portifact/raw?to=%2Findex.html%3Fq%3D1", {
      headers: FROM_APP,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/index.html?q=1`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const set = response.headers.getSetCookie().find((c) => c.startsWith(`${NO_BAR_COOKIE}=`));
    expect(set?.split("; ").slice(1)).toEqual([
      "Max-Age=3600",
      "Path=/",
      "Secure",
      "HttpOnly",
      "SameSite=Lax",
    ]);
    const cookie = set?.split(";")[0];
    const page = await send("/index.html?q=1", { cookie, headers: TOP_LEVEL });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(PAGE);
    // Only that exact cookie and value skip the viewer; anything else still opens it.
    for (const other of [`${NO_BAR_COOKIE}=0`, "__host-pf_nobar=1", `${cookie}; ${cookie}`]) {
      expect((await send("/", { cookie: other, headers: TOP_LEVEL })).status, other).toBe(303);
    }
  });

  it("starts an opt-out only from a top-level navigation, and only towards this origin", async () => {
    for (const headers of [VIEWER_FRAME, SAME_ORIGIN, SIBLING, {}]) {
      const refused = await send("/__portifact/raw", { headers });
      expect(refused.status, JSON.stringify(headers)).toBe(400);
      expect(refused.headers.getSetCookie()).toEqual([]);
    }
    for (const to of ["//evil.example/", "/__portifact/review/end", "https://evil.example/"]) {
      const response = await send(`/__portifact/raw?${new URLSearchParams({ to })}`, {
        headers: TOP_LEVEL,
      });
      expect(response.headers.get("location"), to).toBe(`${ORIGIN}/`);
    }
    expect((await send("/__portifact/raw", { headers: TOP_LEVEL, method: "POST" })).status).toBe(
      405,
    );
  });

  it("starts review on the page the viewer names, and only on a page of this origin", async () => {
    const exchange = await send(`/__portifact/review?code=${await code()}&to=%2Fapp.js%3Fx%3D1`);
    expect(exchange.status).toBe(303);
    const check = new URL(exchange.headers.get("location") ?? "");
    expect(check.pathname).toBe("/__portifact/review/check");
    expect(check.searchParams.get("to")).toBe("/app.js?x=1");
    const cookie = reviewSetCookie(exchange)?.split(";")[0];
    const landed = await send(`${check.pathname}${check.search}`, { cookie });
    expect(landed.headers.get("location")).toBe(`${ORIGIN}/app.js?x=1`);
    for (const to of ["//evil.example/", "/__portifact/review/end", "https://evil.example/"]) {
      const query = new URLSearchParams({ to });
      const refused = await send(`/__portifact/review/check?${query}`, { cookie });
      expect(refused.headers.get("location"), to).toBe(`${ORIGIN}/`);
    }
    const twice = await send("/__portifact/review/check?to=%2Fa&to=%2Fb", { cookie });
    expect(twice.headers.get("location")).toBe(`${ORIGIN}/`);
    const unsafe = await send(`/__portifact/review?code=${await code()}&to=%2F%2Fevil.example`);
    expect(new URL(unsafe.headers.get("location") ?? "").search).toBe("");
  });
});
