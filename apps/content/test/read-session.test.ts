// Entry to protected artifacts on the artifact origin. The app's part (checking the account
// and issuing the handoff) is played by `issueReadHandoff`, the same service the app calls;
// apps/app/test/read-handoff.test.ts covers the app route itself.
import { env } from "cloudflare:test";
import { READ_SESSION } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { issueReadHandoff, suspendArtifact } from "@portifact/services";
import { beforeEach, describe, expect, it } from "vitest";
import type { LogOpening, Opening } from "../src/access-log.ts";
import {
  clearCookie,
  cookieValue,
  READ_COOKIE,
  seal,
  TRANSACTION_COOKIE_PREFIX,
  unseal,
  usableSecret,
} from "../src/cookies.ts";
import { handle } from "../src/index.ts";
import { sameOriginPath } from "../src/read-session.ts";

const ID = "k7d2qm4xab";
const OTHER_ID = "p3n5wq7yzc";
const ORIGIN = `https://${ID}.portifact.dev`;
const OTHER_ORIGIN = `https://${OTHER_ID}.portifact.dev`;
const APP = "https://app.portifact.com";
const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
const CLAIMS_MS = READ_SESSION.claimsTtlSeconds * 1000;
const HANDOFF_MS = READ_SESSION.handoffTtlSeconds * 1000;
const SESSION_MS = READ_SESSION.sessionTtlSeconds * 1000;
const PAGE = "<h1>Plan</h1>";
const db = () => regionsFromEnv(env).get("default").db;

const OWNER = "u_owner";
const READER = "u_reader";
const STRANGER = "u_stranger";

type Mode = "public" | "authenticated" | "restricted";

/** ID of the app session (Better Auth) that `userId` signed in with. */
const appSession = (userId: string) => `as_${userId}`;

async function seed(overrides: Partial<typeof schema.artifacts.$inferInsert> = {}) {
  for (const table of [
    "traffic_counters",
    "read_sessions",
    "read_handoffs",
    "artifact_readers",
    "version_files",
    "versions",
    "objects",
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
        { id: STRANGER, email: "stranger@example.com" },
      ].map((user) => ({
        ...user,
        name: user.id,
        emailVerified: true,
        createdAt: at,
        updatedAt: at,
      })),
    );
  // The app.portifact.com session each account signed in to the artifact with.
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
  const hash = "a".repeat(64);
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
        // Top-level visits here test the artifact itself; the viewer redirect has its own tests.
        bar: false,
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
  await db().insert(schema.artifactReaders).values({ artifactId: ID, email: "reader@example.com" });
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
  cookie?: string | undefined;
  now?: number;
  origin?: string;
  method?: string;
  secret?: string | undefined;
  /** Receives the openings the request records in the owner's access log. */
  logOpening?: LogOpening;
}

function send(path: string, options: Send = {}) {
  const headers = new Headers(options.headers ?? NAVIGATE);
  if (options.cookie) headers.set("Cookie", options.cookie);
  const request = new Request(`${options.origin ?? ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
  });
  const testEnv = "secret" in options ? { ...env, READ_SESSION_SECRET: options.secret } : env;
  return handle(request, testEnv, options.now ?? NOW, undefined, options.logOpening);
}

/** The `name=value` pair a response sets for `name`, or undefined. */
function setCookieFor(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
}

function pair(response: Response, name: string): string {
  const cookie = setCookieFor(response, name);
  if (!cookie) throw new Error(`${name} was not set`);
  return cookie.split(";")[0] ?? "";
}

/** Transaction cookies a response sets or clears. */
function transactionCookies(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .filter((cookie) => cookie.startsWith(TRANSACTION_COOKIE_PREFIX));
}

/** The `name=value` pair of the transaction cookie a response opens. */
function txPair(response: Response): string {
  const opened = transactionCookies(response).filter((cookie) => !cookie.includes("Max-Age=0"));
  expect(opened).toHaveLength(1);
  return opened[0]?.split(";")[0] ?? "";
}

const nameOf = (cookiePair: string) => cookiePair.slice(0, cookiePair.indexOf("="));

/** Starts the entry flow and returns the transaction cookie and the state sent to the app. */
async function start(path = "/", origin = ORIGIN, options: Send = {}) {
  const response = await send(path, { origin, ...options });
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location") ?? "");
  return {
    response,
    location,
    state: location.searchParams.get("state") ?? "",
    tx: txPair(response),
  };
}

/** A browser's cookie jar for one artifact origin: applies `Set-Cookie` like a browser. */
class Jar {
  readonly cookies = new Map<string, string>();
  apply(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [cookiePair = ""] = cookie.split(";");
      const name = nameOf(cookiePair);
      if (cookie.includes("Max-Age=0")) this.cookies.delete(name);
      else this.cookies.set(name, cookiePair.slice(name.length + 1));
    }
    return response;
  }
  get header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  get transactions() {
    return [...this.cookies.keys()].filter((name) => name.startsWith(TRANSACTION_COOKIE_PREFIX));
  }
}

async function issue(userId: string, state: string, artifactId = ID, now = NOW) {
  const result = await issueReadHandoff(db(), {
    artifactId,
    userId,
    authSessionId: appSession(userId),
    state,
    now,
  });
  if (!result.ok) throw new Error(`no access for ${userId}: ${result.code}`);
  return result.value.code;
}

function callback(code: string, cookie: string | undefined, options: Send = {}) {
  return send(`/__portifact/callback?code=${code}`, { headers: FROM_APP, cookie, ...options });
}

/** Runs the whole entry flow for `userId` and returns the read cookie pair. */
async function signIn(userId: string, path = "/") {
  const { state, tx } = await start(path);
  const response = await callback(await issue(userId, state), tx);
  expect(response.status).toBe(303);
  return pair(response, READ_COOKIE);
}

async function sealedClaims(overrides: Record<string, unknown>, secret = env.READ_SESSION_SECRET) {
  const value = await seal(secret, "pf_read", {
    v: 1,
    sid: "s".repeat(43),
    aid: ID,
    uid: READER,
    gen: 1,
    exp: NOW + CLAIMS_MS,
    sexp: NOW + SESSION_MS,
    ...overrides,
  });
  return `${READ_COOKIE}=${value}`;
}

/** Raw SQL against the test database, for changes the app would make. */
const sql = (query: string, ...values: unknown[]) =>
  env.DB.prepare(query)
    .bind(...values)
    .run();

const bumpPolicy = () =>
  sql("UPDATE artifacts SET policy_generation = policy_generation + 1 WHERE id = ?", ID);

describe("protected entry flow", () => {
  beforeEach(() => seed());

  it("sends a visitor through the app and back to the requested path with a read session", async () => {
    const { response, location, state, tx } = await start("/docs/page?tab=2");
    expect(`${location.origin}${location.pathname}`).toBe(`${APP}/read/${ID}`);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([...location.searchParams.keys()]).toEqual(["state"]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(transactionCookies(response)).toEqual([
      expect.stringMatching(
        /^__Host-pf_read_tx_[A-Za-z0-9_-]{16}=[^;]+; Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax$/,
      ),
    ]);

    const back = await callback(await issue(READER, state), tx);
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(`${ORIGIN}/docs/page?tab=2`);
    expect(back.headers.get("cache-control")).toBe("no-store");
    expect(back.headers.get("referrer-policy")).toBe("no-referrer");
    expect(transactionCookies(back)).toEqual([clearCookie(nameOf(tx))]);
    const read = setCookieFor(back, READ_COOKIE) ?? "";
    expect(read).toMatch(
      /^__Host-pf_read=[^;]+; Max-Age=43200; Path=\/; Secure; HttpOnly; SameSite=Lax$/,
    );
    expect(read).not.toContain("Domain");
    // No credential or email travels in the URL back to the artifact.
    expect(back.headers.get("location")).not.toContain("code");

    const cookie = read.split(";")[0];
    const page = await send("/", { cookie });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(PAGE);
    expect(page.headers.get("cache-control")).toBe("private, no-cache");
    expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(page.headers.get("set-cookie")).toBeNull();
    const script = await send("/app.js", { cookie, headers: SAME_ORIGIN });
    expect(script.status).toBe(200);
  });

  it("admits every account that the policy admits", async () => {
    for (const [mode, userId] of [
      ["restricted", OWNER],
      ["restricted", READER],
      ["authenticated", STRANGER],
    ] as [Mode, string][]) {
      await seed({ accessMode: mode });
      const cookie = await signIn(userId);
      expect((await send("/", { cookie })).status).toBe(200);
    }
  });

  it("keeps protected artifacts closed to anonymous visitors in every mode", async () => {
    for (const mode of ["authenticated", "restricted"] as const) {
      await seed({ accessMode: mode });
      const navigation = await send("/");
      expect(navigation.status).toBe(303);
      expect(await navigation.text()).not.toContain(PAGE);
      const script = await send("/app.js", { headers: SAME_ORIGIN });
      expect(script.status).toBe(401);
      expect(await script.text()).not.toContain(PAGE);
      expect(script.headers.get("set-cookie")).toBeNull();
    }
  });

  it("checks the traffic quota after authorization: sign-in first, then 429 for a reader", async () => {
    await db()
      .insert(schema.trafficCounters)
      .values({
        ownerId: OWNER,
        cycleStart: Date.UTC(2026, 10, 1),
        requests: 1_000_000,
        bytes: 0,
        updatedAt: NOW,
      });
    // An anonymous visitor learns nothing about the owner's traffic.
    expect((await send("/")).status).toBe(303);
    const cookie = await signIn(READER);
    const response = await send("/", { cookie });
    expect(response.status).toBe(429);
    expect(response.headers.get("portifact-error")).toBe("traffic_exceeded");
    expect(await response.text()).not.toContain(PAGE);
  });

  it("serves public artifacts without a session", async () => {
    await seed({ accessMode: "public" });
    const response = await send("/", { headers: {} });
    expect(response.status).toBe(200);
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-site");
  });

  it("answers a public artifact that is not servable exactly like an unknown one", async () => {
    const unknown = "zzzzzzzzzz";
    const snapshot = async (response: Response, id: string) => ({
      status: response.status,
      // The ID, the state and the transaction cookie's name and value differ on every request.
      location:
        response.headers
          .get("location")
          ?.replace(`/read/${id}?`, "/read/<id>?")
          .replace(/state=[^&]+/, "state=") ?? null,
      body: await response.text(),
      cookies: response.headers
        .getSetCookie()
        .map((cookie) => cookie.replace(/_tx_[^=]+=[^;]*/, "_tx_=")),
      headers: [...response.headers].filter(
        ([name]) => name !== "set-cookie" && name !== "location",
      ),
    });
    for (const overrides of [
      { state: "archived" as const, archivedAt: NOW - DAY },
      { expiresAt: NOW - 1 },
      { currentVersionId: null },
      { state: "suspended" as const },
    ]) {
      await seed({ accessMode: "public", ...overrides });
      for (const headers of [NAVIGATE, SAME_ORIGIN, {}]) {
        const gone = await snapshot(await send("/", { headers }), ID);
        const missing = await snapshot(
          await send("/", { headers, origin: `https://${unknown}.portifact.dev` }),
          unknown,
        );
        const label = `${JSON.stringify(overrides)} ${JSON.stringify(headers)}`;
        expect(gone, label).toEqual(missing);
      }
    }
  });

  it("answers an unknown artifact exactly like a protected one", async () => {
    const unknown = "zzzzzzzzzz";
    const protectedNav = await send("/");
    const unknownNav = await send("/", { origin: `https://${unknown}.portifact.dev` });
    expect(unknownNav.status).toBe(protectedNav.status);
    expect(new URL(unknownNav.headers.get("location") ?? "").pathname).toBe(`/read/${unknown}`);
    const protectedScript = await send("/app.js", { headers: SAME_ORIGIN });
    const unknownScript = await send("/app.js", {
      headers: SAME_ORIGIN,
      origin: `https://${unknown}.portifact.dev`,
    });
    expect(unknownScript.status).toBe(protectedScript.status);
    expect(await unknownScript.text()).toBe(await protectedScript.text());
  });

  it("fails closed without fetch metadata and without redirecting", async () => {
    const cookie = await signIn(READER);
    const response = await send("/", { headers: {}, cookie });
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    const text = await response.text();
    expect(text).not.toContain(PAGE);
    expect(text).toContain("Open this artifact in a web browser");
  });

  it("does not honor the read cookie on a sibling artifact's subresource requests", async () => {
    const cookie = await signIn(READER);
    const response = await send("/app.js", { headers: SIBLING, cookie });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(PAGE);
  });

  it("honors the read cookie on navigations from other sites", async () => {
    const cookie = await signIn(READER);
    for (const headers of [
      FROM_APP,
      { ...SIBLING, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
    ]) {
      expect((await send("/", { headers, cookie })).status).toBe(200);
    }
  });

  it("keeps the return path on the artifact origin", async () => {
    const { state, tx } = await start("//evil.example/x");
    const back = await callback(await issue(READER, state), tx);
    expect(new URL(back.headers.get("location") ?? "").origin).toBe(ORIGIN);
    expect(sameOriginPath("/\\evil.example", ORIGIN)).toBe(`${ORIGIN}/\\evil.example`);
    expect(new URL(sameOriginPath("/\\evil.example", ORIGIN)).origin).toBe(ORIGIN);
    expect(sameOriginPath("evil.example", ORIGIN)).toBe(`${ORIGIN}/`);
  });

  it("finishes sign-in for long requested URLs", async () => {
    for (const path of [
      `/docs?q=${"a".repeat(1_500)}`,
      `/docs?q=${"\\".repeat(1_000)}`,
      `/${"a".repeat(1_400)}?q=${"b".repeat(1_400)}`,
    ]) {
      const { state, tx } = await start(path);
      const back = await callback(await issue(READER, state), tx);
      expect(back.status, path).toBe(303);
      expect([
        `${ORIGIN}${new URL(path, ORIGIN).pathname}${new URL(path, ORIGIN).search}`,
        `${ORIGIN}/`,
      ]).toContain(back.headers.get("location"));
      expect(setCookieFor(back, READ_COOKIE)).toBeDefined();
    }
    // Short enough to keep: the full path survives.
    const kept = `/docs?q=${"a".repeat(1_000)}`;
    const { state, tx } = await start(kept);
    const back = await callback(await issue(READER, state), tx);
    expect(back.headers.get("location")).toBe(`${ORIGIN}${kept}`);
  });

  it("returns to the root when the requested URL is too long to keep", async () => {
    const { state, tx } = await start(`/${"a".repeat(2_100)}`);
    const back = await callback(await issue(READER, state), tx);
    expect(back.headers.get("location")).toBe(`${ORIGIN}/`);
  });
});

describe("handoff redemption", () => {
  beforeEach(() => seed());

  it("refuses a replayed code", async () => {
    const { state, tx } = await start();
    const code = await issue(READER, state);
    expect((await callback(code, tx)).status).toBe(303);
    const replay = await callback(code, tx);
    expect(replay.status).toBe(400);
    expect(setCookieFor(replay, READ_COOKIE)).toBeUndefined();
    // A failed callback leaves live transactions alone: another tab may still need them.
    expect(transactionCookies(replay)).toEqual([]);
    expect(replay.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("refuses an expired code", async () => {
    const { state, tx } = await start();
    const code = await issue(READER, state);
    expect((await callback(code, tx, { now: NOW + HANDOFF_MS })).status).toBe(400);
  });

  it("refuses an expired transaction", async () => {
    const { state, tx } = await start();
    const later = NOW + READ_SESSION.transactionTtlSeconds * 1000;
    const code = await issue(READER, state, ID, later - 1000);
    expect((await callback(code, tx, { now: later })).status).toBe(400);
  });

  it("refuses a code issued for another artifact", async () => {
    const other = await start("/", OTHER_ORIGIN);
    const mine = await start();
    // A code for OTHER_ID, bound to this browser's nonce on ID, brought to ID.
    const code = await issue(OWNER, mine.state, OTHER_ID);
    expect((await callback(code, mine.tx)).status).toBe(400);
    // The same code on its own origin, but with another origin's transaction cookie.
    expect((await callback(code, mine.tx, { origin: OTHER_ORIGIN })).status).toBe(400);
    expect(other.state).not.toBe(mine.state);
  });

  it("refuses a code without this browser's transaction (fixation)", async () => {
    const attacker = await start();
    const code = await issue(STRANGER, attacker.state).catch(() => "");
    const ownerCode = await issue(OWNER, attacker.state);
    const victim = await start();
    expect((await callback(ownerCode, victim.tx)).status).toBe(400);
    expect((await callback(ownerCode, undefined)).status).toBe(400);
    expect(code).toBe("");
  });

  it("refuses callbacks that are not navigations or carry a malformed code", async () => {
    const { state, tx } = await start();
    const code = await issue(READER, state);
    expect((await callback(code, tx, { headers: SAME_ORIGIN })).status).toBe(400);
    expect((await callback(code, tx, { method: "HEAD" })).status).toBe(400);
    expect(
      (
        await send(`/__portifact/callback?code=${code}&code=${code}`, {
          headers: FROM_APP,
          cookie: tx,
        })
      ).status,
    ).toBe(400);
    expect((await callback("short", tx)).status).toBe(400);
    expect((await send("/__portifact/callback", { headers: FROM_APP, cookie: tx })).status).toBe(
      400,
    );
    // None of these consumed the code.
    expect((await callback(code, tx)).status).toBe(303);
  });

  it("refuses a tampered transaction cookie", async () => {
    const { state, tx } = await start();
    const code = await issue(READER, state);
    const [name, value = ""] = tx.split("=");
    const [body = "", signature = ""] = value.split(".");
    const decoded = JSON.parse(atob(body.replaceAll("-", "+").replaceAll("_", "/")));
    const forged = btoa(JSON.stringify({ ...decoded, path: "/other" }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect((await callback(code, `${name}=${forged}.${signature}`)).status).toBe(400);
    // A read cookie's signature is not valid for a transaction.
    const asRead = await seal(env.READ_SESSION_SECRET, "pf_read", decoded);
    expect((await callback(code, `${name}=${asRead}`)).status).toBe(400);
    // A transaction under another name than its nonce's is not this transaction.
    const other = await start();
    expect((await callback(code, `${nameOf(other.tx)}=${value}`)).status).toBe(400);
  });
});

describe("concurrent sign-ins", () => {
  beforeEach(() => seed());

  it("lets a second tab start signing in without breaking the first", async () => {
    const jar = new Jar();
    const first = await start("/first", ORIGIN, { cookie: jar.header });
    jar.apply(first.response);
    const second = await start("/second", ORIGIN, { cookie: jar.header, now: NOW + 1 });
    jar.apply(second.response);
    expect(nameOf(second.tx)).not.toBe(nameOf(first.tx));
    expect(transactionCookies(second.response)).toHaveLength(1);
    expect(jar.transactions).toHaveLength(2);

    const firstBack = jar.apply(await callback(await issue(READER, first.state), jar.header));
    expect(firstBack.status).toBe(303);
    expect(firstBack.headers.get("location")).toBe(`${ORIGIN}/first`);
    expect(transactionCookies(firstBack)).toEqual([clearCookie(nameOf(first.tx))]);

    const secondBack = jar.apply(await callback(await issue(READER, second.state), jar.header));
    expect(secondBack.status).toBe(303);
    expect(secondBack.headers.get("location")).toBe(`${ORIGIN}/second`);
    expect(jar.transactions).toEqual([]);
  });

  it("keeps at most three sign-ins open and drops the oldest", async () => {
    const jar = new Jar();
    const started = [];
    for (let i = 0; i < 4; i += 1) {
      const step = await start(`/tab${i}`, ORIGIN, { cookie: jar.header, now: NOW + i });
      jar.apply(step.response);
      started.push(step);
    }
    expect(jar.transactions).toHaveLength(3);
    expect(jar.transactions).not.toContain(nameOf(started[0]?.tx ?? ""));
    const oldest = await callback(await issue(READER, started[0]?.state ?? ""), jar.header);
    expect(oldest.status).toBe(400);
    const newest = await callback(await issue(READER, started[3]?.state ?? ""), jar.header);
    expect(newest.headers.get("location")).toBe(`${ORIGIN}/tab3`);
  });

  it("clears expired and unreadable transactions when a sign-in starts", async () => {
    const jar = new Jar();
    jar.apply((await start("/old")).response);
    const [stale = ""] = jar.transactions;
    const garbage = `${TRANSACTION_COOKIE_PREFIX}garbage00000000`;
    const oversized = `${TRANSACTION_COOKIE_PREFIX}oversized0000000`;
    const injected = `${TRANSACTION_COOKIE_PREFIX}injected00000000`;
    jar.cookies.set(garbage, "not-a-sealed-value");
    jar.cookies.set(oversized, "v".repeat(2_049));
    const later = NOW + READ_SESSION.transactionTtlSeconds * 1000;
    // A name sent twice means something injected a second cookie: neither value is trusted.
    const cookie = `${jar.header}; ${injected}=a; ${injected}=b`;
    const response = jar.apply((await start("/new", ORIGIN, { cookie, now: later })).response);
    expect(transactionCookies(response)).toEqual(
      expect.arrayContaining(
        [stale, garbage, oversized, injected].map((name) => clearCookie(name)),
      ),
    );
    expect(jar.transactions).toHaveLength(1);
  });
});

describe("read session claims", () => {
  beforeEach(() => seed());

  it("trusts fresh claims without D1 and rechecks once they expire", async () => {
    const cookie = await signIn(READER);
    await env.DB.exec("DELETE FROM read_sessions");
    expect((await send("/", { cookie, now: NOW + CLAIMS_MS - 1 })).status).toBe(200);
    const later = await send("/", { cookie, now: NOW + CLAIMS_MS });
    expect(later.status).toBe(303);
    expect(setCookieFor(later, READ_COOKIE)).toBe(clearCookie(READ_COOKIE));
  });

  it("ends access within the claims lifetime once the reader signs out of the app", async () => {
    const cookie = await signIn(READER);
    await sql("DELETE FROM sessions WHERE user_id = ?", READER);
    expect((await send("/", { cookie, now: NOW + CLAIMS_MS - 1 })).status).toBe(200);
    const later = await send("/", { cookie, now: NOW + CLAIMS_MS });
    expect(later.status).toBe(303);
    expect(setCookieFor(later, READ_COOKIE)).toBe(clearCookie(READ_COOKIE));
    const script = await send("/app.js", { cookie, headers: SAME_ORIGIN, now: NOW + CLAIMS_MS });
    expect(script.status).toBe(401);
  });

  it("ends access once the app session expires", async () => {
    const cookie = await signIn(READER);
    await sql("UPDATE sessions SET expires_at = ? WHERE user_id = ?", NOW + CLAIMS_MS, READER);
    expect((await send("/", { cookie, now: NOW + CLAIMS_MS })).status).toBe(303);
  });

  it("renews claims after they expire while access remains", async () => {
    const cookie = await signIn(READER);
    const later = NOW + CLAIMS_MS + 5_000;
    const response = await send("/", { cookie, now: later });
    expect(response.status).toBe(200);
    const renewed = pair(response, READ_COOKIE);
    expect(setCookieFor(response, READ_COOKIE)).toContain(
      `Max-Age=${(SESSION_MS - CLAIMS_MS - 5_000) / 1000}`,
    );
    await env.DB.exec("DELETE FROM read_sessions");
    // The renewed claims are good for another 60 seconds.
    expect((await send("/", { cookie: renewed, now: later + CLAIMS_MS - 1 })).status).toBe(200);
  });

  it("applies a revocation at once when the policy generation changes", async () => {
    const cookie = await signIn(READER);
    await sql("DELETE FROM artifact_readers WHERE email = ?", "reader@example.com");
    await bumpPolicy();
    const navigation = await send("/", { cookie, now: NOW + 1 });
    expect(navigation.status).toBe(303);
    expect(new URL(navigation.headers.get("location") ?? "").pathname).toBe(`/read/${ID}`);
    expect(setCookieFor(navigation, READ_COOKIE)).toBe(clearCookie(READ_COOKIE));
    const script = await send("/app.js", { cookie, headers: SAME_ORIGIN, now: NOW + 1 });
    expect(script.status).toBe(401);
    expect(await script.text()).not.toContain(PAGE);
  });

  it("revokes when an artifact becomes restricted to others", async () => {
    await seed({ accessMode: "authenticated" });
    const cookie = await signIn(STRANGER);
    await sql(
      "UPDATE artifacts SET access_mode = 'restricted', policy_generation = 2 WHERE id = ?",
      ID,
    );
    expect((await send("/", { cookie, now: NOW + 1 })).status).toBe(303);
  });

  it("keeps access through a policy change that still admits the account", async () => {
    const cookie = await signIn(READER);
    await bumpPolicy();
    const response = await send("/", { cookie, now: NOW + 1 });
    expect(response.status).toBe(200);
    const renewed = pair(response, READ_COOKIE);
    expect(
      (await send("/", { cookie: renewed, now: NOW + 2 })).headers.get("set-cookie"),
    ).toBeNull();
  });

  it("answers 404 and ends the session when the artifact is archived", async () => {
    const cookie = await signIn(READER);
    await sql("UPDATE artifacts SET state = 'archived', archived_at = ? WHERE id = ?", NOW, ID);
    const response = await send("/", { cookie, now: NOW + 1 });
    expect(response.status).toBe(404);
    expect(setCookieFor(response, READ_COOKIE)).toBe(clearCookie(READ_COOKIE));
  });

  it("answers 404 at once, with fresh claims, when the operator suspends the artifact", async () => {
    const cookie = await signIn(READER);
    const suspended = await suspendArtifact(db(), { artifactId: ID, reason: "phishing", now: NOW });
    expect(suspended.ok).toBe(true);
    for (const headers of [NAVIGATE, SAME_ORIGIN]) {
      const response = await send("/app.js", { cookie, headers, now: NOW + 1 });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(PAGE);
      expect(setCookieFor(response, READ_COOKIE)).toBe(clearCookie(READ_COOKIE));
    }
    // Signing in again is refused too: the app issues no handoff for a suspended artifact.
    const handoff = await issueReadHandoff(db(), {
      artifactId: ID,
      userId: READER,
      authSessionId: appSession(READER),
      state: "state-nonce",
      now: NOW + 2,
    });
    expect(handoff.ok).toBe(false);
    // The owner too.
    const owner = await issueReadHandoff(db(), {
      artifactId: ID,
      userId: OWNER,
      authSessionId: appSession(OWNER),
      state: "state-nonce",
      now: NOW + 2,
    });
    expect(owner.ok).toBe(false);
  });

  it("does not accept one artifact's read cookie on another", async () => {
    const cookie = await signIn(OWNER);
    const response = await send("/", { cookie, origin: OTHER_ORIGIN });
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(`/read/${OTHER_ID}`);
  });

  it("rejects tampered, foreign and injected read cookies", async () => {
    const cookie = await signIn(READER);
    const value = cookie.slice(`${READ_COOKIE}=`.length);
    const [body = "", signature = ""] = value.split(".");
    const claims = JSON.parse(atob(body.replaceAll("-", "+").replaceAll("_", "/")));
    const forgedBody = btoa(JSON.stringify({ ...claims, uid: OWNER }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    // Replaces the second-to-last character, which always carries signature bits.
    const flipped = `${signature.slice(0, -2)}${signature.at(-2) === "A" ? "B" : "A"}${signature.slice(-1)}`;
    for (const bad of [
      `${READ_COOKIE}=${forgedBody}.${signature}`,
      `${READ_COOKIE}=${body}.${flipped}`,
      await sealedClaims({ sid: claims.sid }, "another-secret-that-is-long-enough-to-use"),
      `__host-pf_read=${value}`,
      `pf_read=${value}`,
      `${cookie}; ${cookie}`,
      `${READ_COOKIE}=${body}`,
      `${READ_COOKIE}=${body}.${signature}.x`,
      `${READ_COOKIE}=!!!.${signature}`,
    ]) {
      const response = await send("/", { cookie: bad });
      expect(response.status, bad).toBe(303);
    }
  });

  it("rejects valid signatures over claims that do not fit the schema or the session", async () => {
    const [session] = await db().select().from(schema.readSessions);
    expect(session).toBeUndefined();
    const owner = await signIn(OWNER);
    const sid = JSON.parse(
      atob((owner.split("=")[1]?.split(".")[0] ?? "").replaceAll("-", "+").replaceAll("_", "/")),
    ).sid;
    for (const overrides of [
      { v: 2 },
      { extra: true },
      { sexp: NOW },
      // A signed session of the owner relabeled as the reader is refused on renewal.
      { sid, uid: READER, exp: NOW - 1 },
    ]) {
      expect((await send("/", { cookie: await sealedClaims(overrides) })).status).toBe(303);
    }
    const notJson = await seal(env.READ_SESSION_SECRET, "pf_read", "x");
    expect((await send("/", { cookie: `${READ_COOKIE}=${notJson}` })).status).toBe(303);
  });
});

describe("caching and injected cookies", () => {
  beforeEach(() => seed());

  const ETAG = `"${"a".repeat(64)}"`;

  it("reauthorizes every revalidation: an ETag a reader got earns nobody else a 304", async () => {
    const cookie = await signIn(READER);
    const warm = await send("/", { cookie });
    expect(warm.status).toBe(200);
    expect(warm.headers.get("etag")).toBe(ETAG);
    expect(warm.headers.get("cache-control")).toBe("private, no-cache");
    const revalidate = { "If-None-Match": ETAG };
    expect((await send("/", { cookie, headers: { ...NAVIGATE, ...revalidate } })).status).toBe(304);
    const anonymous = await send("/", { headers: { ...NAVIGATE, ...revalidate } });
    expect(anonymous.status).toBe(303);
    const anonymousScript = await send("/app.js", { headers: { ...SAME_ORIGIN, ...revalidate } });
    expect(anonymousScript.status).toBe(401);
    expect(anonymousScript.headers.get("etag")).toBeNull();
    await sql("DELETE FROM artifact_readers WHERE email = ?", "reader@example.com");
    await bumpPolicy();
    const revoked = await send("/", {
      cookie,
      headers: { ...NAVIGATE, ...revalidate },
      now: NOW + 1,
    });
    expect(revoked.status).toBe(303);
  });

  it("keeps protected responses private, unembeddable and noindex even when embedding and indexing are on", async () => {
    await seed({ embeddable: true, indexable: true });
    const cookie = await signIn(READER);
    const response = await send("/", { cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("content-security-policy")).toBe(
      `frame-ancestors 'self' ${env.APP_ORIGIN}`,
    );
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("grants nothing to hundreds of injected cookies and keeps a reader's session working among them", async () => {
    // What a sibling artifact can plant with Domain=portifact.dev: filler, unprefixed and
    // lowercase look-alikes of Portifact's names, and a second copy of the read cookie's name.
    const injected = [
      ...Array.from({ length: 300 }, (_, i) => `junk${i}=${"x".repeat(64)}`),
      "pf_read=forged",
      "__host-pf_read=forged",
      `${TRANSACTION_COOKIE_PREFIX}forged=forged`,
    ].join("; ");
    const anonymous = await send("/", { cookie: injected });
    expect(anonymous.status).toBe(303);
    expect(await anonymous.text()).not.toContain(PAGE);
    const script = await send("/app.js", { cookie: injected, headers: SAME_ORIGIN });
    expect(script.status).toBe(401);
    const cookie = await signIn(READER);
    const reader = await send("/", { cookie: `${injected}; ${cookie}` });
    expect(reader.status).toBe(200);
    expect(await reader.text()).toBe(PAGE);
    // The answer expires the injected cookies on the shared domain, never the read session.
    const cleared = reader.headers.getSetCookie();
    expect(cleared.length).toBeGreaterThan(0);
    for (const set of cleared) {
      expect(set).toMatch(
        /^[^=]+=; Max-Age=0; Domain=portifact\.dev; Path=\/; Secure; SameSite=None/,
      );
      expect(set.startsWith(`${READ_COOKIE}=`)).toBe(false);
    }
    // Look-alikes of Portifact's names go first.
    expect(cleared[0]?.startsWith("pf_read=") || cleared[0]?.startsWith("__host-pf_read=")).toBe(
      true,
    );
    // A planted second value under the real name makes both untrusted.
    expect((await send("/", { cookie: `${injected}; ${cookie}; ${READ_COOKIE}=x.y` })).status).toBe(
      303,
    );
  });
});

describe("configuration", () => {
  beforeEach(() => seed());

  it("keeps protected artifacts closed when the signing secret is missing", async () => {
    for (const secret of [undefined, "too-short"]) {
      const response = await send("/", { secret });
      expect(response.status).toBe(503);
      expect(transactionCookies(response)).toEqual([]);
      expect((await callback("x".repeat(43), undefined, { secret })).status).toBe(503);
    }
    await seed({ accessMode: "public" });
    expect((await send("/", { secret: undefined })).status).toBe(200);
  });
});

describe("cookie helpers", () => {
  it("reads a cookie only when it appears exactly once with the exact name", () => {
    expect(cookieValue("a=1; __Host-pf_read=v; b=2", READ_COOKIE)).toBe("v");
    expect(cookieValue(null, READ_COOKIE)).toBeNull();
    expect(cookieValue("novalue; __Host-pf_read=v", READ_COOKIE)).toBe("v");
    expect(cookieValue("__HOST-pf_read=v", READ_COOKIE)).toBeNull();
    expect(cookieValue("__Host-pf_read=", READ_COOKIE)).toBeNull();
    expect(cookieValue(`__Host-pf_read=${"v".repeat(2_049)}`, READ_COOKIE)).toBeNull();
  });

  it("requires a long secret and rejects malformed sealed values", async () => {
    expect(usableSecret(undefined)).toBe(false);
    expect(usableSecret("x".repeat(31))).toBe(false);
    expect(usableSecret("x".repeat(32))).toBe(true);
    const secret = "x".repeat(32);
    const sealed = await seal(secret, "p", { a: 1 });
    expect(await unseal(secret, "p", sealed)).toEqual({ a: 1 });
    expect(await unseal(secret, "q", sealed)).toBeNull();
    expect(await unseal(secret, "p", `${sealed.split(".")[0]}.=`)).toBeNull();
    expect(await unseal(secret, "p", "a.b.c")).toBeNull();
    expect(await unseal(secret, "p", "a")).toBeNull();
    // Base64url characters that do not decode (a lone trailing symbol).
    expect(await unseal(secret, "p", `A.${sealed.split(".")[1]}`)).toBeNull();
    // A correct signature over a body that is not JSON.
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const body = btoa("not json").replace(/=+$/, "");
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`p.${body}`)),
    );
    const signature = btoa(String.fromCharCode(...mac))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(await unseal(secret, "p", `${body}.${signature}`)).toBeNull();
  });
});

describe("access log openings", () => {
  beforeEach(() => seed());

  const recorder = () => {
    const openings: Opening[] = [];
    return { openings, logOpening: (opening: Opening) => openings.push(opening) };
  };

  it("records a signed-in reader's page loads, never the page's subresources", async () => {
    const cookie = await signIn(READER);
    const { openings, logOpening } = recorder();
    expect((await send("/", { cookie, logOpening })).status).toBe(200);
    expect((await send("/app.js", { cookie, headers: SAME_ORIGIN, logOpening })).status).toBe(200);
    expect(openings).toEqual([{ artifactId: ID, userId: READER, at: NOW }]);
  });

  it("records nothing on an artifact any signed-in account may open", async () => {
    // Any site can send a signed-in visitor here and the handoff completes without a click.
    await sql("UPDATE artifacts SET access_mode = 'authenticated' WHERE id = ?", ID);
    const cookie = await signIn(STRANGER);
    const { openings, logOpening } = recorder();
    expect((await send("/", { cookie, logOpening })).status).toBe(200);
    expect(openings).toEqual([]);
  });

  it("records nothing for the owner, a missing page, a refusal or the sign-in steps", async () => {
    const { openings, logOpening } = recorder();
    const owner = await signIn(OWNER);
    expect((await send("/", { cookie: owner, logOpening })).status).toBe(200);
    const reader = await signIn(READER);
    expect((await send("/missing.html", { cookie: reader, logOpening })).status).toBe(404);
    expect((await send("/", { method: "HEAD", cookie: reader, logOpening })).status).toBe(200);
    const stranger = await start("/", ORIGIN, { logOpening });
    expect(stranger.response.status).toBe(303);
    expect((await send("/", { cookie: reader, headers: SIBLING, logOpening })).status).toBe(401);
    expect(openings).toEqual([]);
  });

  it("records a sibling's link to the artifact but not a frame a sibling opened", async () => {
    const cookie = await signIn(READER);
    const { openings, logOpening } = recorder();
    const fromSibling = { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate" };
    const framed = await send("/", {
      cookie,
      headers: { ...fromSibling, "Sec-Fetch-Dest": "iframe" },
      logOpening,
    });
    // Served, but frame-ancestors keeps it from rendering in the sibling.
    expect(framed.status).toBe(200);
    expect(framed.headers.get("content-security-policy")).toBe(`frame-ancestors 'self' ${APP}`);
    expect(openings).toEqual([]);
    await send("/", {
      cookie,
      headers: { ...fromSibling, "Sec-Fetch-Dest": "document" },
      logOpening,
    });
    // A frame inside the artifact itself is the artifact showing its own page.
    await send("/", {
      cookie,
      headers: {
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "iframe",
      },
      logOpening,
    });
    expect(openings).toEqual([
      { artifactId: ID, userId: READER, at: NOW },
      { artifactId: ID, userId: READER, at: NOW },
    ]);
  });

  it("never identifies visitors of public artifacts", async () => {
    await seed({ accessMode: "public" });
    const { openings, logOpening } = recorder();
    expect((await send("/", { logOpening })).status).toBe(200);
    expect(openings).toEqual([]);
  });
});

describe("the viewer with the Portifact bar on protected artifacts", () => {
  beforeEach(() => seed({ bar: true }));

  it("sends anonymous visitors through sign-in first, like an artifact without the bar", async () => {
    const response = await send("/docs?x=1");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain(`/read/${ID}?state=`);
  });

  it("opens the viewer only once the read session authorized the visit", async () => {
    const cookie = await signIn(READER, "/");
    const openings: Opening[] = [];
    const viewed = await send("/?tab=2", {
      cookie,
      logOpening: (opening) => openings.push(opening),
    });
    expect(viewed.status).toBe(303);
    expect(viewed.headers.get("location")).toBe(
      `https://app.portifact.com/view/${ID}?path=%2F%3Ftab%3D2`,
    );
    expect(viewed.headers.get("cache-control")).toBe("no-store");
    expect(viewed.headers.get("referrer-policy")).toBe("no-referrer");
    // The visitor opened it: the owner's access log names them, as for the page itself.
    expect(openings).toEqual([{ artifactId: ID, userId: READER, at: NOW }]);
    // The page's own subresources and a sibling's loads are never redirected.
    expect((await send("/app.js", { cookie, headers: SAME_ORIGIN })).status).toBe(200);
  });

  it("keeps an account the policy refuses on the sign-in path, never the viewer", async () => {
    await env.DB.exec("DELETE FROM artifact_readers");
    const cookie = await sealedClaims({ uid: READER, exp: NOW - 1 });
    const response = await send("/", { cookie });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).not.toContain("/view/");
  });
});
