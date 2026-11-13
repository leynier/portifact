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
import { CLIENT_SCRIPT, GRANT_COOKIE, GRANT_TX_COOKIE } from "../src/data.ts";
import { resetDeliveryCaches } from "../src/directory.ts";
import { handle } from "../src/index.ts";
import { isPortifactCookie } from "../src/injected.ts";

const NOW = Date.UTC(2026, 10, 13, 12);
const DAY = 86_400_000;
const OWNER = "u_data_owner";
const READER = "u_data_reader";
const db = () => regionsFromEnv(env).get("default").db;
const ON = { ...env, ARTIFACT_DATA_ENABLED: "true" };

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
      expiresAt: NOW + 10 * DAY,
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
      headers: { ...FETCH, "Idempotency-Key": "vote-1" },
    });
    expect(created.status).toBe(201);
    const doc = JSON.parse(created.body);
    const me = JSON.parse((await send(id, "me", { cookie: grant })).body);
    expect(doc._by).toBe(me.visitor.id);

    const again = await send(id, "c/votes", {
      method: "POST",
      body: { choice: "a" },
      cookie: grant,
      headers: { ...FETCH, "Idempotency-Key": "vote-1" },
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
});
