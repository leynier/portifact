// Link sessions on the artifact origin (decision 0008). The app's part (checking the link and
// issuing the one-use code) is played by `openShareLink`, the same service the app's open
// endpoint calls; apps/app/test/share-links.test.ts covers the endpoint itself.
import { env } from "cloudflare:test";
import { READ_SESSION } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import {
  createShareLink,
  issueReadHandoff,
  openShareLink,
  revokeShareLink,
} from "@portifact/services";
import { beforeEach, describe, expect, it } from "vitest";
import type { Opening } from "../src/access-log.ts";
import { READ_COOKIE, seal } from "../src/cookies.ts";
import { handle } from "../src/index.ts";
import { isPortifactCookie } from "../src/injected.ts";
import { SHARE_COOKIE } from "../src/share-session.ts";
import type { ViewCharge } from "../src/views.ts";

const ID = "s7d2qm4xab";
const OTHER_ID = "s3n5wq7yzc";
const ORIGIN = `https://${ID}.portifact.dev`;
const OTHER_ORIGIN = `https://${OTHER_ID}.portifact.dev`;
const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
const CLAIMS_MS = READ_SESSION.claimsTtlSeconds * 1000;
const PAGE = "<h1>Shared plan</h1>";
const OWNER = "u_share_owner";
const READER = "u_share_reader";
const db = () => regionsFromEnv(env).get("default").db;

async function seed(overrides: Partial<typeof schema.artifacts.$inferInsert> = {}) {
  for (const table of [
    "share_sessions",
    "share_handoffs",
    "share_links",
    "traffic_counters",
    "read_sessions",
    "read_handoffs",
    "artifact_readers",
    "version_files",
    "versions",
    "objects",
    "artifacts",
    "owner_plans",
    "sessions",
    "users",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const at = new Date(NOW - 30 * DAY);
  await db()
    .insert(schema.users)
    .values(
      [OWNER, READER].map((id) => ({
        id,
        name: id,
        email: `${id}@example.com`,
        emailVerified: true,
        createdAt: at,
        updatedAt: at,
      })),
    );
  await db()
    .insert(schema.sessions)
    .values({
      id: `as_${READER}`,
      token: "token-reader",
      userId: READER,
      expiresAt: new Date(NOW + 7 * DAY),
      createdAt: at,
      updatedAt: at,
    });
  await db()
    .insert(schema.ownerPlans)
    .values({ ownerId: OWNER, plan: "pro", seats: 1, grantedBy: "test", updatedAt: NOW });
  const hash = "b".repeat(64);
  await env.ARTIFACTS.put(`objects/${OWNER}/${hash}`, PAGE);
  await db()
    .insert(schema.objects)
    .values({
      ownerId: OWNER,
      sha256: hash,
      size: PAGE.length,
      r2Key: `objects/${OWNER}/${hash}`,
      state: "verified",
    });
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
        // The bar is on: a link visitor must still get the artifact, never the viewer.
        bar: true,
        ...overrides,
      });
    await db()
      .insert(schema.versions)
      .values({
        id: `${id}-v1`,
        artifactId: id,
        number: 1,
        authorId: OWNER,
        entrypoint: "index.html",
        publishedBytes: PAGE.length,
      });
    for (const path of ["index.html", "app.js"]) {
      await db()
        .insert(schema.versionFiles)
        .values({
          versionId: `${id}-v1`,
          kind: "published",
          path,
          ownerId: OWNER,
          sha256: hash,
          size: PAGE.length,
          contentType: path.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8",
        });
    }
  }
  await db()
    .insert(schema.artifactReaders)
    .values({ artifactId: ID, email: `${READER}@example.com` });
}

const NAVIGATE = {
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};
const SAME_ORIGIN = {
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Dest": "script",
};
const SIBLING = {
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Dest": "script",
};
const FROM_APP = {
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};

interface Send {
  headers?: Record<string, string>;
  cookie?: string;
  now?: number;
  origin?: string;
  secret?: string | undefined;
  openings?: Opening[];
  /** Receives the page views the request counts for the owner's analytics. */
  views?: ViewCharge[];
}

function send(path: string, options: Send = {}) {
  const headers = new Headers(options.headers ?? NAVIGATE);
  if (options.cookie) headers.set("Cookie", options.cookie);
  const request = new Request(`${options.origin ?? ORIGIN}${path}`, { headers });
  const testEnv = "secret" in options ? { ...env, READ_SESSION_SECRET: options.secret } : env;
  return handle(
    request,
    testEnv,
    options.now ?? NOW,
    undefined,
    (opening) => options.openings?.push(opening),
    (view) => options.views?.push(view),
  );
}

/** Raw SQL against the test database, for changes the app or the operator would make. */
const sql = (query: string, ...values: unknown[]) =>
  env.DB.prepare(query)
    .bind(...values)
    .run();

const setPlan = (plan: "free" | "pro") =>
  sql("UPDATE owner_plans SET plan = ? WHERE owner_id = ?", plan, OWNER);

function setCookieFor(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
}

/** A link of ID and the one-use code its entry would hand the visitor. */
async function link(extra: { password?: string; artifactId?: string } = {}) {
  const created = await createShareLink(db(), {
    userId: OWNER,
    artifactId: extra.artifactId ?? ID,
    label: "Board",
    expiresAt: null,
    password: extra.password,
    now: NOW,
  });
  if (!created.ok) throw new Error(created.message);
  const opened = await openShareLink([db()], {
    token: created.value.token,
    password: extra.password,
    now: NOW,
  });
  if (opened.kind !== "opened") throw new Error(opened.kind);
  return { linkId: created.value.link.id, token: created.value.token, code: opened.code };
}

/** Redeems a code like the browser coming from the entry page; returns the cookie pair. */
async function enter(code: string, options: Send = {}) {
  const response = await send(`/__portifact/link?code=${code}`, { headers: FROM_APP, ...options });
  expect(response.status).toBe(303);
  return (setCookieFor(response, SHARE_COOKIE) ?? "").split(";")[0] ?? "";
}

describe("a share link's session", () => {
  beforeEach(() => seed());

  it("redeems the code into a host-only cookie and returns to the root, with nothing in the URL", async () => {
    const { code, token } = await link();
    const response = await send(`/__portifact/link?code=${code}`, { headers: FROM_APP });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    const cookie = setCookieFor(response, SHARE_COOKIE) ?? "";
    expect(cookie).toMatch(
      /^__Host-pf_link=[^;]+; Max-Age=43200; Path=\/; Secure; HttpOnly; SameSite=Lax$/,
    );
    expect(cookie).not.toContain("Domain");
    expect(cookie).not.toContain(token);
    expect(cookie).not.toContain(code);
  });

  it("serves the artifact itself, never the viewer, with no referrer and framed only by itself", async () => {
    const { code } = await link();
    const cookie = await enter(code);
    const page = await send("/", { cookie });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(PAGE);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(page.headers.get("x-robots-tag")).toBe("noindex");
    expect(page.headers.get("cache-control")).toBe("private, no-cache");
    const script = await send("/app.js", { cookie, headers: SAME_ORIGIN });
    expect(script.status).toBe(200);
  });

  it("is not usable by a sibling's subresource requests, nor on another artifact", async () => {
    const { code } = await link();
    const cookie = await enter(code);
    const sibling = await send("/app.js", { cookie, headers: SIBLING });
    expect(sibling.status).toBe(401);
    expect(await sibling.text()).not.toContain(PAGE);
    const other = await send("/", { cookie, origin: OTHER_ORIGIN });
    expect(other.status).not.toBe(200);
    expect(setCookieFor(other, SHARE_COOKIE)).toContain("Max-Age=0");
  });

  it("redeems a code once, only for its own host and only from a top-level cross-site navigation", async () => {
    const { code } = await link();
    for (const headers of [
      { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
      { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" },
      { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
      {},
    ]) {
      const refused = await send(`/__portifact/link?code=${code}`, { headers });
      expect(refused.status, JSON.stringify(headers)).toBe(400);
      expect(setCookieFor(refused, SHARE_COOKIE)).toBeUndefined();
    }
    const wrongHost = await send(`/__portifact/link?code=${code}`, {
      headers: FROM_APP,
      origin: OTHER_ORIGIN,
    });
    expect(wrongHost.status).toBe(400);
    await enter(code);
    const replay = await send(`/__portifact/link?code=${code}`, { headers: FROM_APP });
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("This share link has expired or was revoked");
    expect((await send("/__portifact/link?code=x&code=y", { headers: FROM_APP })).status).toBe(400);
    expect(
      (await send(`/__portifact/link?code=${code}`, { headers: FROM_APP, secret: undefined }))
        .status,
    ).toBe(503);
  });

  it("ends within the claims' minute after a revocation and clears the cookie", async () => {
    const { code, linkId } = await link();
    const cookie = await enter(code);
    const revoked = await revokeShareLink(db(), {
      userId: OWNER,
      artifactId: ID,
      linkId,
      now: NOW,
    });
    expect(revoked.ok).toBe(true);
    // Claims already issued are trusted for at most their minute.
    expect((await send("/", { cookie, now: NOW + CLAIMS_MS - 1 })).status).toBe(200);
    const ended = await send("/", { cookie, now: NOW + CLAIMS_MS });
    expect(ended.status).toBe(403);
    expect(await ended.text()).toContain("This share link has expired or was revoked");
    expect(setCookieFor(ended, SHARE_COOKIE)).toContain("Max-Age=0");
    const asset = await send("/app.js", { cookie, headers: SAME_ORIGIN, now: NOW + CLAIMS_MS });
    expect(asset.status).toBe(401);
  });

  it("renews its claims while the link lives", async () => {
    const { code } = await link();
    const cookie = await enter(code);
    const later = await send("/", { cookie, now: NOW + CLAIMS_MS + 1 });
    expect(later.status).toBe(200);
    expect(setCookieFor(later, SHARE_COOKIE)).toMatch(/^__Host-pf_link=[^;]+; Max-Age=\d+/);
  });

  it("stops at once when the artifact is suspended or archived, or the plan loses the feature", async () => {
    for (const change of ["suspend", "archive", "plan"] as const) {
      await seed();
      const { code } = await link();
      const cookie = await enter(code);
      if (change === "plan") {
        await setPlan("free");
      } else if (change === "suspend") {
        await sql("UPDATE artifacts SET state = 'suspended' WHERE id = ?", ID);
      } else {
        await sql("UPDATE artifacts SET state = 'archived', archived_at = ? WHERE id = ?", NOW, ID);
      }
      const refused = await send("/", { cookie });
      expect(refused.status, change).toBe(403);
      expect(await refused.text(), change).not.toContain(PAGE);
    }
  });

  it("works again through a new entry once the plan includes share links again", async () => {
    const { token } = await link();
    await setPlan("free");
    expect(await openShareLink([db()], { token, now: NOW })).toEqual({ kind: "unavailable" });
    await setPlan("pro");
    const opened = await openShareLink([db()], { token, now: NOW });
    if (opened.kind !== "opened") throw new Error(opened.kind);
    const cookie = await enter(opened.code);
    expect((await send("/", { cookie })).status).toBe(200);
  });

  it("records openings for the link, never a person, and only page loads", async () => {
    const { code, linkId } = await link();
    const cookie = await enter(code);
    const openings: Opening[] = [];
    await send("/", { cookie, openings });
    await send("/app.js", { cookie, headers: SAME_ORIGIN, openings });
    expect(openings).toEqual([{ artifactId: ID, userId: linkId, linkId, at: NOW }]);
  });

  it("counts a page load through a link as one anonymous view, never a signed-in one", async () => {
    // Share links and analytics are both Pro features; the seeded owner is on Pro.
    const { code } = await link();
    const views: ViewCharge[] = [];
    // The redeeming redirect itself is not a view.
    const cookie = await enter(code, { views });
    expect(views).toEqual([]);
    expect((await send("/", { cookie, views })).status).toBe(200);
    await send("/app.js", { cookie, headers: SAME_ORIGIN, views });
    expect(views).toEqual([
      { artifactId: ID, ownerId: OWNER, at: NOW, visitorId: null, expiresAt: expect.any(Number) },
    ]);
  });

  it("lets a signed-in reader's own read session win, so a link never changes what they get", async () => {
    const { code } = await link();
    const linkCookie = await enter(code);
    const started = await send("/");
    const location = new URL(started.headers.get("location") ?? "");
    const tx = (
      setCookieFor(started, "__Host-pf_read_tx_") ??
      started.headers.getSetCookie()[0] ??
      ""
    ).split(";")[0];
    const issued = await issueReadHandoff(db(), {
      artifactId: ID,
      userId: READER,
      authSessionId: `as_${READER}`,
      state: location.searchParams.get("state") ?? "",
      now: NOW,
    });
    if (!issued.ok) throw new Error(issued.message);
    const back = await send(`/__portifact/callback?code=${issued.value.code}`, {
      headers: FROM_APP,
      cookie: tx ?? "",
    });
    const read = (setCookieFor(back, READ_COOKIE) ?? "").split(";")[0] ?? "";
    const openings: Opening[] = [];
    // The bar is on: with the read session the reader goes to the viewer, as before the link.
    const page = await send("/", { cookie: `${read}; ${linkCookie}`, openings });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toContain("/view/");
    expect(openings).toEqual([{ artifactId: ID, userId: READER, at: NOW }]);
  });

  it("trusts no forged, foreign or look-alike cookie", async () => {
    expect(isPortifactCookie(SHARE_COOKIE)).toBe(true);
    // A value sealed under another purpose (a read cookie's) never validates as a link session.
    const forged = await seal(env.READ_SESSION_SECRET, "pf_read", {
      v: 1,
      sid: "s".repeat(43),
      aid: ID,
      lid: `sl_${"0".repeat(32)}`,
      exp: NOW + CLAIMS_MS,
      sexp: NOW + DAY,
    });
    const refused = await send("/", { cookie: `${SHARE_COOKIE}=${forged}` });
    expect(refused.status).toBe(403);
    expect(setCookieFor(refused, SHARE_COOKIE)).toContain("Max-Age=0");

    const { code } = await link();
    const value = (await enter(code)).slice(SHARE_COOKIE.length + 1);
    // A sibling can only plant a look-alike name, which grants nothing and is cleared.
    const planted = await send("/", { cookie: `__host-pf_link=${value}` });
    expect(planted.status).toBe(303);
    expect(planted.headers.get("location")).toContain("/read/");
    expect(
      planted.headers.getSetCookie().some((c) => c.startsWith("__host-pf_link=; Max-Age=0")),
    ).toBe(true);
    // Two values under the exact name mean one was injected: neither is trusted.
    const doubled = await send("/", {
      cookie: `${SHARE_COOKIE}=${value}; ${SHARE_COOKIE}=${value}`,
    });
    expect(doubled.status).toBe(303);
  });
});
