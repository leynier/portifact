// The page's routes of artifact data (decision 0026, delivery 6) on the artifact origin, against
// the real documents object (the data Worker bound by script name): the gates, the top-level and
// frame grant flows, the one-use code bound to the browser that began, `me`, a visitor's own
// documents, readers without a grant, revocation within a minute and the switch.
import { env } from "cloudflare:test";
import { TERMS_VERSION } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import {
  dataNamespaces,
  declareDataCollection,
  issueDataGrantCode,
  revokeDataGrants,
} from "@portifact/services";
import { describe, expect, it } from "vitest";
import { READ_COOKIE, seal } from "../src/cookies.ts";
import { CLIENT_SCRIPT, GRANT_COOKIE, GRANT_TX_COOKIE } from "../src/data.ts";
import { resetDeliveryCaches } from "../src/directory.ts";
import { handle } from "../src/index.ts";
import { isPortifactCookie } from "../src/injected.ts";

const NOW = Date.UTC(2026, 10, 13, 12);
const DAY = 86_400_000;
const OWNER = "u_data_owner";
const READER = "u_data_reader";
const db = () => regionsFromEnv(env).get("default").db;
const ON = { ...env, ARTIFACT_DATA_ENABLED: "true", DATA_PAGE_WRITES_ENABLED: "true" };

const NAVIGATE_TOP = {
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};
const FROM_APP_TOP = {
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};
const FROM_APP_FRAME = {
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "iframe",
};
const SIBLING_TOP = {
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};
const FETCH = {
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
};

let counter = 0;
/** A fresh artifact ID, so each test gets an object of its own. */
function freshId(): string {
  counter += 1;
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return `dt${alphabet[(counter >> 5) & 31]}${alphabet[counter & 31]}aaaaaa`;
}

async function seed(accessMode: "public" | "restricted" = "public") {
  for (const table of [
    "data_grant_codes",
    "data_grants",
    "artifact_data",
    "traffic_counters",
    "artifact_readers",
    "artifacts",
    "owner_plans",
    "sessions",
    "users",
    "tombstones",
    "rate_limits",
    "outbox",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  resetDeliveryCaches();
  const at = new Date(NOW - 30 * DAY);
  await db()
    .insert(schema.users)
    .values(
      [OWNER, READER].map((id) => ({
        id,
        name: id === READER ? "Rea Der" : "Owner",
        email: `${id}@example.com`,
        emailVerified: true,
        termsVersion: TERMS_VERSION,
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
  const id = freshId();
  await db()
    .insert(schema.artifacts)
    .values({
      id,
      ownerId: OWNER,
      type: "site",
      name: "Board",
      state: "active",
      accessMode,
      currentVersionId: `${id}-v1`,
      expiresAt: NOW + 60 * DAY,
    });
  const declared = await declareDataCollection(
    db(),
    { objects: dataNamespaces(env, "default"), bucket: env.ARTIFACTS, enabled: true },
    {
      userId: OWNER,
      artifactId: id,
      now: NOW,
      idempotencyKey: crypto.randomUUID(),
      declaration: { name: "votes", mode: "own" },
    },
  );
  if (!declared.ok) throw new Error(`declare failed: ${declared.code} ${declared.message}`);
  return id;
}

interface Sent {
  status: number;
  headers: Headers;
  body: string;
  cookies: string[];
}

async function send(
  id: string,
  path: string,
  options: {
    headers?: Record<string, string>;
    cookie?: string;
    method?: string;
    body?: unknown;
    now?: number;
    on?: boolean;
  } = {},
): Promise<Sent> {
  const headers = new Headers(options.headers ?? FETCH);
  if (options.cookie) headers.set("Cookie", options.cookie);
  const method = options.method ?? "GET";
  if (method !== "GET") {
    headers.set("Origin", `https://${id}.portifact.dev`);
    headers.set("Content-Type", "application/json");
  }
  const request = new Request(`https://${id}.portifact.dev/__portifact/data/${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const response = await handle(request, options.on === false ? env : ON, options.now ?? NOW);
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
    cookies: response.headers.getSetCookie(),
  };
}

/** `name=value` of a named cookie among a response's `Set-Cookie` headers. */
function cookieOf(sent: Sent, name: string): string {
  const header = sent.cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (!header) throw new Error(`no ${name} cookie`);
  return header.split(";")[0] as string;
}

/** The whole top-level flow: begin, the app's code for the reader, redemption. */
async function granted(id: string, flow: "top" | "frame" = "top") {
  const begun = await send(id, `grant/begin?flow=${flow}`, {
    headers: flow === "top" ? NAVIGATE_TOP : FROM_APP_FRAME,
  });
  const tx = cookieOf(begun, GRANT_TX_COOKIE);
  const nonceHash =
    flow === "top"
      ? (new URL(begun.headers.get("Location") as string).searchParams.get("nonce") as string)
      : (/"nonceHash":"([A-Za-z0-9_-]{43})"/.exec(begun.body)?.[1] as string);
  const issued = await issueDataGrantCode(db(), env.ARTIFACTS, {
    artifactId: id,
    userId: READER,
    authSessionId: `as_${READER}`,
    nonceHash,
    requestedHost: null,
    contentDomain: "portifact.dev",
    customDomains: false,
    now: NOW,
  });
  if (!issued.ok) throw new Error(`issue failed: ${issued.code}`);
  const redeemed = await send(id, `grant?flow=${flow}&code=${issued.value.code}`, {
    headers: flow === "top" ? FROM_APP_TOP : FROM_APP_FRAME,
    cookie: tx,
  });
  return { begun, tx, code: issued.value.code, redeemed };
}

describe("artifact data on the artifact origin", () => {
  it("answers every data path 404 while artifact data is off", async () => {
    const id = await seed();
    for (const path of ["me", "data.js", "grant/begin?flow=top", "c/votes"]) {
      expect((await send(id, path, { on: false, headers: NAVIGATE_TOP })).status, path).toBe(404);
    }
  });

  it("serves the client script and never treats the grant cookies as foreign", async () => {
    const id = await seed();
    const script = await send(id, "data.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(script.body).toBe(CLIENT_SCRIPT);
    expect(isPortifactCookie(GRANT_COOKIE)).toBe(true);
    expect(isPortifactCookie(GRANT_TX_COOKIE)).toBe(true);
  });

  it("says granted: false the same for everyone until a grant, then knows only the visitor", async () => {
    const id = await seed();
    const before = await send(id, "me");
    expect(before.status).toBe(200);
    expect(JSON.parse(before.body)).toEqual({ granted: false });
    expect(before.cookies).toEqual([]);

    const { redeemed } = await granted(id);
    expect(redeemed.status).toBe(303);
    expect(redeemed.headers.get("Location")).toContain("/__portifact/data/grant/check");
    const grant = cookieOf(redeemed, GRANT_COOKIE);
    const header = redeemed.cookies.find((c) => c.startsWith(`${GRANT_COOKIE}=`)) as string;
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Partitioned");

    const me = JSON.parse((await send(id, "me", { cookie: grant })).body);
    expect(me).toMatchObject({ granted: true, visitor: { name: "Rea Der" }, write: true });
    expect(me.visitor.id).toMatch(/^v_/);
    expect(JSON.stringify(me)).not.toContain("example.com");
  });

  it("writes and reads the visitor's own documents, keyed by the page", async () => {
    const id = await seed();
    const grant = cookieOf((await granted(id)).redeemed, GRANT_COOKIE);
    const created = await send(id, "c/votes", {
      method: "POST",
      body: { choice: "a" },
      cookie: grant,
      headers: { ...FETCH, "Idempotency-Key": `${NOW}.vote0000one` },
    });
    expect(created.status).toBe(201);
    const doc = JSON.parse(created.body);
    const me = JSON.parse((await send(id, "me", { cookie: grant })).body);
    expect(doc._by).toBe(me.visitor.id);

    const again = await send(id, "c/votes", {
      method: "POST",
      body: { choice: "a" },
      cookie: grant,
      headers: { ...FETCH, "Idempotency-Key": `${NOW}.vote0000one` },
    });
    expect(again.status).toBe(200);
    expect(JSON.parse(again.body)).toMatchObject({ replayed: true });

    const listed = JSON.parse((await send(id, "c/votes", { cookie: grant })).body);
    expect(listed.documents).toHaveLength(1);
    expect(
      JSON.parse((await send(id, `c/votes/${doc._id}`, { cookie: grant })).body),
    ).toMatchObject({ choice: "a" });
    const mine = JSON.parse((await send(id, "mine", { cookie: grant })).body);
    expect(mine.rows).toHaveLength(1);
    const removed = await send(id, `c/votes/${doc._id}`, { method: "DELETE", cookie: grant });
    expect(removed.status).toBe(200);
  });

  it("refuses writes without a grant, and data requests from anywhere but the page itself", async () => {
    const id = await seed();
    const write = await send(id, "c/votes", { method: "POST", body: { choice: "a" } });
    expect(write.status).toBe(403);
    expect(JSON.parse(write.body)).toMatchObject({ error: { code: "forbidden" } });
    // A reader of a public artifact reads an own collection as empty.
    expect(JSON.parse((await send(id, "c/votes")).body)).toEqual({ documents: [], next: null });
    for (const site of ["same-site", "cross-site"]) {
      const sibling = await send(id, "me", { headers: { ...FETCH, "Sec-Fetch-Site": site } });
      expect(sibling.status, site).toBe(403);
    }
    const noMetadata = await send(id, "me", { headers: {} });
    expect(noMetadata.status).toBe(403);
  });

  it("answers a protected artifact's data like a missing one without a reading session", async () => {
    const id = await seed("restricted");
    expect((await send(id, "me")).status).toBe(404);
    expect((await send(id, "grant/begin?flow=top", { headers: NAVIGATE_TOP })).status).toBe(403);
  });

  it("starts and redeems a grant only through their own gates", async () => {
    const id = await seed();
    expect((await send(id, "grant/begin?flow=top", { headers: SIBLING_TOP })).status).toBe(403);
    expect((await send(id, "grant/begin?flow=top", { headers: FETCH })).status).toBe(403);
    const { tx, code } = await (async () => {
      const begun = await send(id, "grant/begin?flow=top", { headers: NAVIGATE_TOP });
      const nonceHash = new URL(begun.headers.get("Location") as string).searchParams.get(
        "nonce",
      ) as string;
      const issued = await issueDataGrantCode(db(), env.ARTIFACTS, {
        artifactId: id,
        userId: READER,
        authSessionId: `as_${READER}`,
        nonceHash,
        requestedHost: null,
        contentDomain: "portifact.dev",
        customDomains: false,
        now: NOW,
      });
      if (!issued.ok) throw new Error(issued.code);
      return { tx: cookieOf(begun, GRANT_TX_COOKIE), code: issued.value.code };
    })();
    // A sibling's same-site navigation, or a frame navigation for a top-level code.
    expect(
      (await send(id, `grant?flow=top&code=${code}`, { headers: SIBLING_TOP, cookie: tx })).status,
    ).toBe(403);
    // Another browser (no transaction, or another one) gets nothing, and spends nothing.
    expect(
      (await send(id, `grant?flow=top&code=${code}`, { headers: FROM_APP_TOP })).cookies,
    ).not.toContainEqual(expect.stringContaining(`${GRANT_COOKIE}=e1`));
    const other = cookieOf(
      await send(id, "grant/begin?flow=top", { headers: NAVIGATE_TOP }),
      GRANT_TX_COOKIE,
    );
    const wrong = await send(id, `grant?flow=top&code=${code}`, {
      headers: FROM_APP_TOP,
      cookie: other,
    });
    expect(wrong.status).toBe(403);
    // The browser that began redeems it once.
    const first = await send(id, `grant?flow=top&code=${code}`, {
      headers: FROM_APP_TOP,
      cookie: tx,
    });
    expect(first.status).toBe(303);
    const second = await send(id, `grant?flow=top&code=${code}`, {
      headers: FROM_APP_TOP,
      cookie: tx,
    });
    expect(second.status).toBe(403);
  });

  it("runs the frame flow with partitioned cookies and tells the viewer by its exact origin", async () => {
    const id = await seed();
    const { begun, redeemed } = await granted(id, "frame");
    expect(begun.status).toBe(200);
    expect(begun.body).toContain(JSON.stringify(env.APP_ORIGIN));
    expect(begun.headers.get("Content-Security-Policy")).toContain(
      `frame-ancestors ${env.APP_ORIGIN}`,
    );
    const tx = begun.cookies.find((c) => c.startsWith(`${GRANT_TX_COOKIE}=`)) as string;
    expect(tx).toContain("SameSite=None; Partitioned");
    const header = redeemed.cookies.find((c) => c.startsWith(`${GRANT_COOKIE}=`)) as string;
    expect(header).toContain("SameSite=None; Partitioned");
    const checked = await send(id, "grant/check?flow=frame&to=/", {
      headers: FROM_APP_FRAME,
      cookie: header.split(";")[0] as string,
    });
    expect(checked.body).toContain("portifact:data-granted");
    const missing = await send(id, "grant/check?flow=frame&to=/", { headers: FROM_APP_FRAME });
    expect(missing.body).toContain("portifact:data-grant-unavailable");
  });

  it("stops writes within a minute of revocation", async () => {
    const id = await seed();
    const grant = cookieOf((await granted(id)).redeemed, GRANT_COOKIE);
    await revokeDataGrants(db(), { userId: READER, artifactId: id, now: NOW + 1000 });
    // Within the claims' minute the cookie still speaks; after it, the renewal refuses.
    const later = await send(id, "c/votes", {
      method: "POST",
      body: { choice: "b" },
      cookie: grant,
      now: NOW + 61_000,
    });
    expect(later.status).toBe(403);
    expect(later.cookies.some((c) => c.startsWith(`${GRANT_COOKIE}=;`))).toBe(true);
    const me = JSON.parse((await send(id, "me", { cookie: grant, now: NOW + 61_000 })).body);
    expect(me).toEqual({ granted: false });
  });

  it("answers malformed requests to the API without reaching the object's rules", async () => {
    const id = await seed();
    const grant = cookieOf((await granted(id)).redeemed, GRANT_COOKIE);
    const bad = async (path: string, options: Parameters<typeof send>[2] = {}) =>
      send(id, path, { cookie: grant, ...options });
    expect((await bad("c/Bad-Name")).status).toBe(400);
    expect((await bad("c/votes?q=%7Bnope")).status).toBe(400);
    expect((await bad("c/votes?q=%7B%22limit%22%3A0%7D")).status).toBe(400);
    expect((await bad("c/votes/not-an-id")).status).toBe(404);
    expect((await bad("elsewhere")).status).toBe(404);
    expect((await bad("c/votes/a/b/c")).status).toBe(404);
    expect((await bad("mine?after=nocolon")).status).toBe(400);
    expect((await bad("c/votes", { method: "PATCH", body: {} })).status).toBe(405);
    const created = JSON.parse(
      (await bad("c/votes", { method: "POST", body: { choice: "a" } })).body,
    ) as { _id: string };
    expect((await bad(`c/votes/${created._id}`, { method: "PATCH", body: {} })).status).toBe(405);
    // A body that is not one JSON object is refused before the object.
    const array = await send(id, "c/votes", { method: "POST", body: [1], cookie: grant });
    expect(array.status).toBe(400);
    const replaced = await bad(`c/votes/${created._id}`, { method: "PUT", body: { choice: "b" } });
    expect(replaced.status).toBe(200);
    expect(JSON.parse(replaced.body)).toMatchObject({ choice: "b" });
    const page = JSON.parse((await bad(`mine?after=votes:${created._id}`)).body);
    expect(page.rows).toEqual([]);
  });

  it("renews the grant's claims after a minute and ends the cookie at the grant's end", async () => {
    const id = await seed();
    const grant = cookieOf((await granted(id)).redeemed, GRANT_COOKIE);
    const renewed = await send(id, "me", { cookie: grant, now: NOW + 61_000 });
    expect(JSON.parse(renewed.body)).toMatchObject({ granted: true });
    expect(renewed.cookies.some((c) => c.startsWith(`${GRANT_COOKIE}=e1.`))).toBe(true);
    const ended = await send(id, "me", { cookie: grant, now: NOW + 31 * DAY });
    expect(JSON.parse(ended.body)).toEqual({ granted: false });
  });

  it("ignores another artifact's grant and a frame grant on a top-level document", async () => {
    const id = await seed();
    const frameGrant = (await granted(id, "frame")).redeemed;
    const cookie = cookieOf(frameGrant, GRANT_COOKIE);
    const other = await seed();
    expect(JSON.parse((await send(other, "me", { cookie })).body)).toEqual({ granted: false });
    // A top-level document carrying a frame grant: the check page says nothing was kept.
    const top = await send(id, "grant/check?flow=top", { headers: NAVIGATE_TOP, cookie });
    expect(top.status).toBe(403);
  });

  it("ends the top-level flow on the page, or in the popup's opener", async () => {
    const id = await seed();
    const { redeemed } = await granted(id);
    const cookie = cookieOf(redeemed, GRANT_COOKIE);
    const checked = await send(id, "grant/check?flow=top&to=%2Fboard", {
      headers: NAVIGATE_TOP,
      cookie,
    });
    expect(checked.status).toBe(200);
    expect(checked.body).toContain("window.opener");
    expect(checked.body).toContain('"/board"');
    const outside = await send(id, "grant/check?flow=top&to=%2F%2Fevil.example", {
      headers: NAVIGATE_TOP,
      cookie,
    });
    expect(outside.body).not.toContain("evil.example");
  });

  it("refuses a frame redemption without its transaction by telling the viewer", async () => {
    const id = await seed();
    const answered = await send(id, `grant?flow=frame&code=${"c".repeat(43)}`, {
      headers: FROM_APP_FRAME,
    });
    expect(answered.status).toBe(200);
    expect(answered.body).toContain("portifact:data-grant-unavailable");
  });

  it("answers 503 without the cookie secret, and serves the script to HEAD with no body", async () => {
    const id = await seed();
    const request = new Request(`https://${id}.portifact.dev/__portifact/data/me`, {
      headers: FETCH,
    });
    const response = await handle(request, { ...ON, READ_SESSION_SECRET: "short" }, NOW);
    expect(response.status).toBe(503);
    const head = await handle(
      new Request(`https://${id}.portifact.dev/__portifact/data/data.js`, { method: "HEAD" }),
      ON,
      NOW,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("lets a restricted artifact's reader in through their read session, and nobody else", async () => {
    const id = await seed("restricted");
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: id, email: `${READER}@example.com` });
    const value = await seal(env.READ_SESSION_SECRET, "pf_read", {
      v: 1,
      sid: "s".repeat(43),
      aid: id,
      uid: READER,
      gen: 1,
      exp: NOW + 10 * 60_000,
      sexp: NOW + DAY,
    });
    const read = `${READ_COOKIE}=${value}`;
    const me = await send(id, "me", { cookie: read });
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body)).toEqual({ granted: false });
    // An artifact that does not exist answers like a refused one.
    expect((await send("zzzzzzzzzz", "me", { cookie: read })).status).toBe(404);
  });

  it("refuses data requests once the owner's traffic for the month is spent", async () => {
    const id = await seed();
    const start = Date.UTC(2026, 10, 1);
    await db().insert(schema.trafficCounters).values({
      ownerId: OWNER,
      cycleStart: start,
      requests: 10_000_000,
      bytes: 0,
      updatedAt: NOW,
    });
    resetDeliveryCaches();
    const answered = await send(id, "me");
    expect(answered.status).toBe(429);
  });

  it("refuses a late transaction, one of the other flow, a repeated code and a body over the limit", async () => {
    const id = await seed();
    const begun = await send(id, "grant/begin?flow=top&to=%2F%2Fevil.example", {
      headers: NAVIGATE_TOP,
    });
    const tx = cookieOf(begun, GRANT_TX_COOKIE);
    const code = "c".repeat(43);
    const late = await send(id, `grant?flow=top&code=${code}`, {
      headers: FROM_APP_TOP,
      cookie: tx,
      now: NOW + 6 * 60_000,
    });
    expect(late.status).toBe(403);
    const otherFlow = await send(id, `grant?flow=frame&code=${code}`, {
      headers: FROM_APP_FRAME,
      cookie: tx,
    });
    expect(otherFlow.body).toContain("portifact:data-grant-unavailable");
    const twice = await send(id, `grant?flow=top&code=${code}&code=${code}`, {
      headers: FROM_APP_TOP,
      cookie: tx,
    });
    expect(twice.status).toBe(403);
    const garbled = await send(id, `grant?flow=top&code=${code}`, {
      headers: FROM_APP_TOP,
      cookie: `${GRANT_TX_COOKIE}=e1.not.sealed`,
    });
    expect(garbled.status).toBe(403);

    const grant = cookieOf((await granted(id)).redeemed, GRANT_COOKIE);
    const huge = await send(id, "c/votes", {
      method: "POST",
      body: { text: "x".repeat(90 * 1024) },
      cookie: grant,
    });
    expect(huge.status).toBe(400);
  });

  // Review of #279, finding 6: the shipped client's DELETE, exactly as it sends it.
  it("deletes a document with the request the shipped client script makes", async () => {
    const id = await seed();
    const grant = cookieOf((await granted(id)).redeemed, GRANT_COOKIE);
    const created = JSON.parse(
      (await send(id, "c/votes", { method: "POST", cookie: grant, body: { choice: "a" } })).body,
    ) as { _id: string };
    // Run the client script against a stub window and capture the request it builds.
    const requests: { url: string; init: RequestInit }[] = [];
    const page: {
      portifact?: { data: { collection(name: string): { remove(id: string): Promise<unknown> } } };
    } = {};
    // The script's own clock is the test's, as the Worker's is.
    const run = new Function("window", "fetch", "location", "crypto", "Date", CLIENT_SCRIPT);
    run(
      page,
      async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return new Response("{}", { status: 200 });
      },
      { origin: `https://${id}.portifact.dev`, pathname: "/", search: "" },
      crypto,
      { now: () => NOW },
    );
    await page.portifact?.data.collection("votes").remove(created._id);
    const sent = requests.at(-1);
    if (!sent) throw new Error("the client sent nothing");
    const headers = new Headers(sent.init.headers);
    headers.set("Cookie", grant);
    headers.set("Origin", `https://${id}.portifact.dev`);
    for (const [name, value] of Object.entries(FETCH)) headers.set(name, value);
    const response = await handle(
      new Request(`https://${id}.portifact.dev${sent.url}`, {
        method: sent.init.method ?? "GET",
        headers,
      }),
      ON,
      NOW,
    );
    expect(response.status).toBe(200);
    const listed = JSON.parse((await send(id, "c/votes", { cookie: grant })).body);
    expect(listed.documents).toEqual([]);
  });

  // Review of #279, finding 4: the page-write switch.
  it("refuses page creates and replacements while page writes are off, and keeps reads, deletes and the export", async () => {
    const id = await seed();
    const grant = cookieOf((await granted(id)).redeemed, GRANT_COOKIE);
    const created = JSON.parse(
      (await send(id, "c/votes", { method: "POST", cookie: grant, body: { choice: "a" } })).body,
    ) as { _id: string };
    const off = { ...ON, DATA_PAGE_WRITES_ENABLED: "false" };
    const request = (method: string, path: string, body?: unknown) =>
      handle(
        new Request(`https://${id}.portifact.dev/__portifact/data/${path}`, {
          method,
          headers: {
            ...FETCH,
            Origin: `https://${id}.portifact.dev`,
            "Content-Type": "application/json",
            Cookie: grant,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        off,
        NOW,
      );
    const createOff = await request("POST", "c/votes", { choice: "after-pause" });
    expect(createOff.status).toBe(503);
    expect(await createOff.json()).toMatchObject({ error: { code: "capacity_unavailable" } });
    expect((await request("PUT", `c/votes/${created._id}`, { choice: "b" })).status).toBe(503);
    // Unset is off too: only exactly "true" lets the page write.
    const { DATA_PAGE_WRITES_ENABLED: _, ...unset } = ON;
    const unsetCreate = await handle(
      new Request(`https://${id}.portifact.dev/__portifact/data/c/votes`, {
        method: "POST",
        headers: {
          ...FETCH,
          Origin: `https://${id}.portifact.dev`,
          "Content-Type": "application/json",
          Cookie: grant,
        },
        body: JSON.stringify({ choice: "c" }),
      }),
      unset,
      NOW,
    );
    expect(unsetCreate.status).toBe(503);
    expect((await request("GET", "c/votes")).status).toBe(200);
    expect((await request("GET", "mine")).status).toBe(200);
    expect((await request("DELETE", `c/votes/${created._id}`)).status).toBe(200);
  });

  // Review of #279, finding 5: the handoff routes act for an artifact.
  it("refuses every grant handoff step once the owner's traffic is spent", async () => {
    const id = await seed();
    await db()
      .insert(schema.trafficCounters)
      .values({
        ownerId: OWNER,
        cycleStart: Date.UTC(2026, 10, 1),
        requests: 10_000_000,
        bytes: 0,
        updatedAt: NOW,
      });
    resetDeliveryCaches();
    expect((await send(id, "me")).status).toBe(429);
    const begun = await send(id, "grant/begin?flow=top", { headers: NAVIGATE_TOP });
    expect(begun.status).toBe(429);
    expect(begun.cookies).toEqual([]);
    const redeemed = await send(id, `grant?flow=top&code=${"c".repeat(43)}`, {
      headers: FROM_APP_TOP,
    });
    expect(redeemed.status).toBe(429);
    expect((await send(id, "grant/check?flow=top", { headers: NAVIGATE_TOP })).status).toBe(429);
  });

  it("charges each authorized grant handoff step to the owner's traffic", async () => {
    const id = await seed();
    const charged: unknown[] = [];
    const count = (charge: unknown) => charged.push(charge);
    const begun = await handle(
      new Request(`https://${id}.portifact.dev/__portifact/data/grant/begin?flow=top`, {
        headers: NAVIGATE_TOP,
      }),
      ON,
      NOW,
      count,
    );
    expect(begun.status).toBe(303);
    expect(charged).toHaveLength(1);
    const checked = await handle(
      new Request(`https://${id}.portifact.dev/__portifact/data/grant/check?flow=top`, {
        headers: NAVIGATE_TOP,
      }),
      ON,
      NOW,
      count,
    );
    expect(checked.status).toBe(403);
    expect(charged).toHaveLength(2);
    // A refusal at the gate, before authorization, charges nothing.
    await handle(
      new Request(`https://${id}.portifact.dev/__portifact/data/grant/begin?flow=top`, {
        headers: SIBLING_TOP,
      }),
      ON,
      NOW,
      count,
    );
    expect(charged).toHaveLength(2);
  });

  // Review of #279, finding 7: the page never chooses a document's author.
  it("records the grant holder as the author whatever the page puts in the body", async () => {
    const id = await seed();
    const grant = cookieOf((await granted(id)).redeemed, GRANT_COOKIE);
    const me = JSON.parse((await send(id, "me", { cookie: grant })).body);
    for (const field of ["author", "by", "visitor"]) {
      const created = await send(id, "c/votes", {
        method: "POST",
        cookie: grant,
        body: { choice: "injected", [field]: "v_BBBBBBBBBBBBBBBBBBBB" },
      });
      expect(created.status).toBe(201);
      expect(JSON.parse(created.body)._by).toBe(me.visitor.id);
    }
  });
});
