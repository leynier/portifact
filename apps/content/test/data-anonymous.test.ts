// Anonymous writers on the artifact origin (decision 0026, delivery 9), against the real documents
// object: a code from `issueAnonymousDataGrantCode` redeems only through `anon=1` with the browser
// that began; the page then knows an opaque visitor ID and nothing else and writes as it; and the
// grant stops renewing within the claims' minute once anything closes anonymous writing (the
// switch, the owner's setting, the artifact leaving public, a workspace's policy or plan).
import { env } from "cloudflare:test";
import { DATA_GRANT, DEFAULT_POLICY, TERMS_VERSION } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import {
  dataNamespaces,
  declareDataCollection,
  issueAnonymousDataGrantCode,
} from "@portifact/services";
import { describe, expect, it } from "vitest";
import { GRANT_COOKIE, GRANT_TX_COOKIE } from "../src/data.ts";
import { resetDeliveryCaches } from "../src/directory.ts";
import { handle } from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 14, 12);
const MINUTE = 60_000;
const OWNER = "u_anon_owner";
const WS = "ws_anonymous0000000000";
const db = () => regionsFromEnv(env).get("default").db;
const ON = {
  ...env,
  ARTIFACT_DATA_ENABLED: "true",
  DATA_PAGE_WRITES_ENABLED: "true",
  DATA_ANONYMOUS_ENABLED: "true",
};

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
const FETCH = {
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
};

let counter = 0;
function freshId(): string {
  counter += 1;
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return `an${alphabet[(counter >> 5) & 31]}${alphabet[counter & 31]}aaaaaa`;
}

async function reset() {
  for (const table of [
    "data_anonymous_grants",
    "data_grant_codes",
    "data_grants",
    "artifact_data",
    "traffic_counters",
    "artifacts",
    "owner_plans",
    "workspaces",
    "users",
    "rate_limits",
    "outbox",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  resetDeliveryCaches();
  await db()
    .insert(schema.users)
    .values({
      id: OWNER,
      name: "Owner",
      email: `${OWNER}@example.com`,
      emailVerified: true,
      termsVersion: TERMS_VERSION,
      createdAt: new Date(NOW - 30 * 86_400_000),
      updatedAt: new Date(NOW - 30 * 86_400_000),
    });
}

/** A public artifact with a `shared` collection, owned by `owner`, with its data's writers. */
async function seed(owner = OWNER, writers: "anyone" | "signed_in" = "anyone") {
  const id = freshId();
  await db()
    .insert(schema.artifacts)
    .values({
      id,
      ownerId: owner,
      type: "site",
      name: "Guestbook",
      state: "active",
      accessMode: "public",
      currentVersionId: `${id}-v1`,
      expiresAt: NOW + 60 * 86_400_000,
    });
  // The owner's declaration registers the data; a workspace's is made through its row directly.
  if (owner === OWNER) {
    const declared = await declareDataCollection(
      db(),
      { objects: dataNamespaces(env, "default"), bucket: env.ARTIFACTS, enabled: true },
      {
        userId: OWNER,
        artifactId: id,
        now: NOW,
        idempotencyKey: crypto.randomUUID(),
        declaration: { name: "notes", mode: "shared" },
      },
    );
    if (!declared.ok) throw new Error(`declare failed: ${declared.code}`);
  } else {
    await db().insert(schema.artifactData).values({ artifactId: id, updatedAt: NOW });
  }
  await setWriters(id, writers);
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
    env?: typeof ON;
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
  const response = await handle(request, options.env ?? ON, options.now ?? NOW);
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
    cookies: response.headers.getSetCookie(),
  };
}

function cookieOf(sent: Sent, name: string): string {
  const header = sent.cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (!header) throw new Error(`no ${name} cookie`);
  return header.split(";")[0] as string;
}

/** Begins in this tab, takes an anonymous code for its nonce, then redeems it. */
async function anonymousFlow(id: string, query = "anon=1") {
  const begun = await send(id, "grant/begin?flow=top", { headers: NAVIGATE_TOP });
  const tx = cookieOf(begun, GRANT_TX_COOKIE);
  const nonceHash = new URL(begun.headers.get("Location") as string).searchParams.get(
    "nonce",
  ) as string;
  const issued = await issueAnonymousDataGrantCode(db(), {
    artifactId: id,
    nonceHash,
    requestedHost: null,
    contentDomain: "portifact.dev",
    customDomains: false,
    enabled: true,
    addressKey: "k".repeat(32),
    termsVersion: TERMS_VERSION,
    now: NOW,
  });
  if (!issued.ok) throw new Error(`issue failed: ${issued.code}`);
  const redeemed = await send(id, `grant?flow=top&${query}&code=${issued.value.code}`, {
    headers: FROM_APP_TOP,
    cookie: tx,
  });
  return { tx, code: issued.value.code, redeemed };
}

async function granted(id: string) {
  const { redeemed } = await anonymousFlow(id);
  expect(redeemed.status).toBe(303);
  return cookieOf(redeemed, GRANT_COOKIE);
}

describe("anonymous writers on the artifact origin", () => {
  it("knows only an opaque visitor ID and writes as it", async () => {
    await reset();
    const id = await seed();
    const grant = await granted(id);
    const me = JSON.parse((await send(id, "me", { cookie: grant })).body);
    expect(me).toEqual({
      granted: true,
      visitor: { id: expect.stringMatching(/^v_/), name: "" },
      write: true,
      anonymous: true,
    });
    const created = await send(id, "c/notes", {
      method: "POST",
      body: { text: "hello" },
      cookie: grant,
    });
    expect(created.status).toBe(201);
    expect(JSON.parse(created.body)).toMatchObject({ text: "hello", _by: me.visitor.id });
    // Each anonymous grant is a new author: a second browser is somebody else.
    const other = await granted(id);
    const second = JSON.parse((await send(id, "me", { cookie: other })).body);
    expect(second.visitor.id).not.toBe(me.visitor.id);
    expect(JSON.parse((await send(id, "mine", { cookie: other })).body).rows).toEqual([]);
  });

  it("redeems an anonymous code only as one, once, with the browser that began", async () => {
    await reset();
    const id = await seed();
    // Without the anonymous name the code is looked up among people's grants and found nowhere.
    const plain = await anonymousFlow(id, "x=1");
    expect(plain.redeemed.status).toBe(403);
    expect(plain.redeemed.cookies.some((cookie) => cookie.startsWith(`${GRANT_COOKIE}=`))).toBe(
      false,
    );
    const { tx, code, redeemed } = await anonymousFlow(id);
    expect(redeemed.status).toBe(303);
    const again = await send(id, `grant?flow=top&anon=1&code=${code}`, {
      headers: FROM_APP_TOP,
      cookie: tx,
    });
    expect(again.status).toBe(403);
  });

  it("stops renewing within a minute once anonymous writing closes", async () => {
    await reset();
    const later = NOW + DATA_GRANT.claimsTtlSeconds * 1000 + 1;
    const closers: [string, (id: string) => Promise<unknown>, typeof ON?][] = [
      ["the owner's setting", (id) => setWriters(id, "signed_in")],
      [
        "leaving public",
        (id) =>
          env.DB.prepare("UPDATE artifacts SET access_mode = 'authenticated' WHERE id = ?")
            .bind(id)
            .run(),
      ],
      ["the switch", async () => undefined, { ...ON, DATA_ANONYMOUS_ENABLED: "false" }],
    ];
    for (const [name, close, closedEnv] of closers) {
      // The free plan holds one artifact with data: each case starts over.
      await reset();
      const id = await seed();
      const grant = await granted(id);
      const fresh = await send(id, "c/notes", {
        method: "POST",
        body: { n: 1 },
        cookie: grant,
        now: later,
      });
      expect(fresh.status, name).toBe(201);
      await close(id);
      resetDeliveryCaches();
      const closed = await send(id, "c/notes", {
        method: "POST",
        body: { n: 2 },
        cookie: grant,
        now: later + MINUTE,
        ...(closedEnv ? { env: closedEnv } : {}),
      });
      expect(closed.status, name).not.toBe(201);
      if (!closedEnv) {
        const me = JSON.parse((await send(id, "me", { cookie: grant, now: later + MINUTE })).body);
        // Not granted any more; an artifact that left public is not even readable without a session.
        expect(me.granted, name).not.toBe(true);
      }
    }
  });

  it("holds a workspace's artifacts to its plan and its policy", async () => {
    await reset();
    await db()
      .insert(schema.workspaces)
      .values({ id: WS, slug: "anon-ws", name: "Anon WS", createdBy: OWNER, updatedAt: NOW });
    const id = await seed(WS);
    const issue = () =>
      issueAnonymousDataGrantCode(db(), {
        artifactId: id,
        nonceHash: "n".repeat(43),
        requestedHost: null,
        contentDomain: "portifact.dev",
        customDomains: false,
        enabled: true,
        addressKey: "w".repeat(32),
        termsVersion: TERMS_VERSION,
        now: NOW,
      });
    // No plan with `policies`: closed, like a missing artifact.
    expect(await issue()).toMatchObject({ ok: false, code: "not_found" });
    await db()
      .insert(schema.ownerPlans)
      .values({ ownerId: WS, plan: "enterprise", grantedBy: "test", updatedAt: NOW });
    // The plan alone is not enough: the default policy forbids anonymous writers.
    expect(await issue()).toMatchObject({ ok: false, code: "not_found" });
    await env.DB.prepare("UPDATE workspaces SET policy = ? WHERE id = ?")
      .bind(JSON.stringify({ ...DEFAULT_POLICY, anonymousDataWriters: "allowed" }), WS)
      .run();
    expect((await issue()).ok).toBe(true);
    const grant = await granted(id);
    const later = NOW + DATA_GRANT.claimsTtlSeconds * 1000 + 1;
    expect(JSON.parse((await send(id, "me", { cookie: grant, now: later })).body).granted).toBe(
      true,
    );
    // An admin tightens the policy: the next renewal ends the grant, nothing else to write.
    await env.DB.prepare("UPDATE workspaces SET policy = NULL WHERE id = ?").bind(WS).run();
    const after = later + MINUTE;
    expect(JSON.parse((await send(id, "me", { cookie: grant, now: after })).body)).toEqual({
      granted: false,
    });
  });
});

function setWriters(id: string, writers: "anyone" | "signed_in") {
  return env.DB.prepare("UPDATE artifact_data SET writers = ? WHERE artifact_id = ?")
    .bind(writers, id)
    .run();
}
