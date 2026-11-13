// PR 280 review: live updates must end with the credential that opened them, never outlive a
// revoked grant's claims, and reach only the page's collection modes. Against the real content
// Worker and documents object; the clock is the real one, so the object's alarms are not already
// past.
import { env } from "cloudflare:test";
import { TERMS_VERSION } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import {
  createDataDocument,
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

const NOW = Date.now();
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

const LIVE_ON = { ...ON, DATA_LIVE_ENABLED: "true" };

async function liveRequest(id: string, cookie?: string, now = NOW) {
  return handle(
    new Request(`https://${id}.portifact.dev/__portifact/data/live`, {
      headers: {
        ...FETCH,
        Origin: `https://${id}.portifact.dev`,
        Upgrade: "websocket",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }),
    LIVE_ON,
    now,
  );
}

function listen(socket: WebSocket) {
  const received: Record<string, unknown>[] = [];
  socket.accept();
  socket.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))));
  return {
    received,
    async next(count: number) {
      for (let i = 0; i < 100 && received.length < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(received.length).toBeGreaterThanOrEqual(count);
      return received[count - 1]!;
    },
  };
}

describe("PR 280 review reproductions", () => {
  it("B1: a revoked grant cannot extend a socket beyond its cached claims deadline", async () => {
    const id = await seed();
    const grant = cookieOf((await granted(id)).redeemed, GRANT_COOKIE);
    const response = await liveRequest(id, grant);
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const client = listen(socket);
    try {
      const hello = await client.next(1);
      await revokeDataGrants(db(), { userId: READER, artifactId: id, now: NOW + 1_000 });
      const renewal = await handle(
        new Request(`https://${id}.portifact.dev/__portifact/data/live/renew`, {
          method: "POST",
          headers: {
            ...FETCH,
            Origin: `https://${id}.portifact.dev`,
            "Content-Type": "application/json",
            Cookie: grant,
          },
          body: JSON.stringify({ socket: hello.connected }),
        }),
        LIVE_ON,
        NOW + 59_000,
      );
      // A revoked grant is renewed against D1 before any new window: the renewal is refused,
      // so the connection ends at its first deadline, within the claims' minute.
      expect(renewal.status).toBe(404);
    } finally {
      socket.close(1000);
    }
  });

  it.each(["read", "shared"] as const)(
    "B2: live must not expose the deferred %s mode",
    async (mode) => {
      const id = await seed();
      const deps = {
        objects: dataNamespaces(env, "default"),
        bucket: env.ARTIFACTS,
        enabled: true,
      };
      const declared = await declareDataCollection(db(), deps, {
        userId: OWNER,
        artifactId: id,
        now: NOW,
        idempotencyKey: crypto.randomUUID(),
        declaration: { name: "later", mode },
      });
      expect(declared.ok).toBe(true);
      expect(JSON.parse((await send(id, "c/later")).body)).toEqual({ documents: [], next: null });
      const response = await liveRequest(id);
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      const client = listen(socket);
      try {
        await client.next(1);
        socket.send(JSON.stringify({ subscribe: "later" }));
        const subscription = await client.next(2);
        const created = await createDataDocument(db(), deps, {
          userId: OWNER,
          artifactId: id,
          now: NOW + 1,
          idempotencyKey: crypto.randomUUID(),
          collection: "later",
          body: { secret: "unreleased" },
        });
        expect(created.ok).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect({
          subscription,
          changes: client.received.filter((message) => message.collection === "later"),
        }).toEqual({ subscription: { error: "not_found" }, changes: [] });
      } finally {
        socket.close(1000);
      }
    },
  );
});
