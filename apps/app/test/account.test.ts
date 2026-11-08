import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { tokenClient } from "./api-client.ts";
import {
  authorizeWithPkce,
  callApi,
  callMcp,
  exchangeCode,
  registerMcpClient,
  type TokenResponse,
} from "./flows.ts";
import {
  codeFrom,
  cookieHeader,
  createHarness,
  form,
  type Harness,
  json,
  ORIGIN,
  SESSION_COOKIE,
} from "./harness.ts";

const ARTIFACT_ORIGIN = "https://k7d2qm4xab.portifact.dev";

/** What the dashboard's fetch sends: the session cookie and same-origin fetch metadata. */
function dashboard(
  cookie: string,
  method = "GET",
  extra: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      ...(method === "GET" ? {} : { origin: ORIGIN }),
      ...extra,
    },
  };
}

interface SessionItem {
  current: boolean;
  userAgent: string | null;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
}

interface AppItem {
  clientId: string;
  name: string | null;
  firstParty: boolean;
  resources: string[];
  scopes: string[];
}

async function sessions(h: Harness, cookie: string): Promise<SessionItem[]> {
  const response = await h.request("/api/v1/account/sessions", dashboard(cookie));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json<{ items: SessionItem[] }>()).items;
}

async function apps(h: Harness, cookie: string): Promise<AppItem[]> {
  const response = await h.request("/api/v1/account/apps", dashboard(cookie));
  expect(response.status).toBe(200);
  return (await response.json<{ items: AppItem[] }>()).items;
}

/** Signs in from a browser that names itself, so sessions can be told apart. */
async function signInAs(h: Harness, email: string, userAgent: string): Promise<string> {
  await env.DB.exec("DELETE FROM rate_limits");
  await h.request("/api/auth/email-otp/send-verification-otp", json({ email, type: "sign-in" }));
  const otp = codeFrom(h.outbox.findLast((message) => message.to === email));
  const signedIn = await h.request(
    "/api/auth/sign-in/email-otp",
    json({ email, otp }, { "user-agent": userAgent, cookie: await h.acceptTerms() }),
  );
  return cookieHeader(signedIn);
}

/** Connects an MCP client through authorization code with PKCE and returns its tokens. */
async function connectMcp(
  h: Harness,
  cookie: string,
): Promise<{ clientId: string; token: string; refresh: string }> {
  const clientId = await registerMcpClient(h);
  const { code, verifier } = await authorizeWithPkce(h, { clientId, cookie });
  const tokens = await (await exchangeCode(h, { clientId, code, verifier })).json<TokenResponse>();
  return { clientId, token: tokens.access_token, refresh: tokens.refresh_token ?? "" };
}

describe("browser sessions", () => {
  it("lists only the user's own sessions, this browser first, without tokens or addresses", async () => {
    const h = createHarness();
    const laptop = await signInAs(h, "sessions-own@example.test", "Laptop/1.0");
    const phone = await signInAs(h, "sessions-own@example.test", "Phone/2.0");
    await h.signIn("sessions-someone-else@example.test");

    const fromPhone = await h.request("/api/v1/account/sessions", dashboard(phone));
    const text = await fromPhone.clone().text();
    const items = (await fromPhone.json<{ items: SessionItem[] }>()).items;
    expect(items.map((s) => [s.current, s.userAgent])).toEqual([
      [true, "Phone/2.0"],
      [false, "Laptop/1.0"],
    ]);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual([
      "createdAt",
      "current",
      "expiresAt",
      "lastActiveAt",
      "userAgent",
    ]);
    for (const cookie of [laptop, phone]) {
      expect(text).not.toContain(cookie.split("=")[1]?.split(".")[0]);
    }
    expect((await sessions(h, laptop)).map((s) => s.current)).toEqual([true, false]);
  });

  it("signs out the other sessions like Better Auth's sign-out, keeping this one, other users' and apps", async () => {
    const h = createHarness();
    const cli = await tokenClient(h, "sessions-out@example.test");
    const current = await h.signIn("sessions-out@example.test");
    const otherUser = await h.signIn("sessions-out-other@example.test");
    // An agent approved in the other browser holds tokens bound to that browser session.
    const agent = await connectMcp(h, cli.cookie);
    expect((await callMcp(h, agent.token)).status).toBe(200);

    const response = await h.request(
      "/api/v1/account/sessions/sign-out-others",
      dashboard(current, "POST"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedOut: 1 });

    expect((await sessions(h, current)).map((s) => s.current)).toEqual([true]);
    const signedOut = await h.request("/api/v1/account/sessions", dashboard(cli.cookie));
    expect(signedOut.status).toBe(401);
    expect(await sessions(h, otherUser)).toHaveLength(1);
    // Device tokens are not tied to a browser session: the CLI keeps working.
    expect((await cli.call("/api/v1/me")).status).toBe(200);
    // Better Auth's session hooks revoke what was issued through the ended session.
    expect((await callMcp(h, agent.token)).status).toBe(401);
    const refreshed = await h.request(
      "/api/auth/oauth2/token",
      form({
        grant_type: "refresh_token",
        refresh_token: agent.refresh,
        client_id: agent.clientId,
      }),
    );
    // As with signing out (decision 0001), the agent recovers by refreshing; only
    // disconnecting the app ends its access.
    expect(refreshed.status).toBe(200);
    const renewed = await refreshed.json<TokenResponse>();
    expect((await callMcp(h, renewed.access_token)).status).toBe(200);
  });
});

describe("connected apps", () => {
  it("lists the CLI and MCP clients connected to the user, with their resources and scopes", async () => {
    const h = createHarness();
    const cli = await tokenClient(h, "apps-list@example.test", "artifacts:read offline_access");
    const mcp = await connectMcp(h, cli.cookie);
    const someoneElse = await tokenClient(h, "apps-list-other@example.test");

    const items = await apps(h, cli.cookie);
    expect(items).toHaveLength(2);
    expect(items.find((a) => a.clientId === "portifact-cli")).toMatchObject({
      name: "Portifact CLI",
      firstParty: true,
      resources: ["api"],
      scopes: expect.arrayContaining(["artifacts:read", "offline_access"]),
    });
    expect(items.find((a) => a.clientId === mcp.clientId)).toMatchObject({
      name: "Example MCP client",
      firstParty: false,
      resources: ["mcp"],
    });
    const body = JSON.stringify(items);
    expect(body).not.toContain(mcp.token);
    expect((await apps(h, someoneElse.cookie)).map((a) => a.clientId)).toEqual(["portifact-cli"]);
  });

  it("names only Portifact's resources and says when a token never expires", async () => {
    const h = createHarness();
    const cookie = await h.signIn("apps-odd@example.test");
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind("apps-odd@example.test")
      .first<{ id: string }>();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO oauth_clients (id, client_id, name, redirect_uris, created_at, updated_at) VALUES ('odd', 'odd', 'Odd client', '[]', ?, ?)",
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO oauth_refresh_tokens (id, token, client_id, user_id, resources, scopes, created_at, expires_at) VALUES ('odd-r', 'odd-hash', 'odd', ?, ?, '[\"artifacts:read\"]', ?, NULL)",
      ).bind(user?.id, JSON.stringify(["https://elsewhere.example/api", `${ORIGIN}/mcp`]), now),
    ]);
    const [odd] = await apps(h, cookie);
    expect(odd).toMatchObject({ clientId: "odd", resources: ["mcp"], expiresAt: null });
  });

  it("disconnects an app so its tokens stop working, without touching other users", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "apps-revoke@example.test");
    const other = await tokenClient(h, "apps-revoke-other@example.test");
    const mcp = await connectMcp(h, owner.cookie);

    const revoked = await h.request(
      "/api/v1/account/apps/portifact-cli",
      dashboard(owner.cookie, "DELETE"),
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ clientId: "portifact-cli", disconnected: true });
    expect((await owner.call("/api/v1/me")).status).toBe(401);
    expect((await other.call("/api/v1/me")).status).toBe(200);
    expect((await callMcp(h, mcp.token)).status).toBe(200);

    const disconnectMcp = await h.request(
      `/api/v1/account/apps/${encodeURIComponent(mcp.clientId)}`,
      dashboard(owner.cookie, "DELETE"),
    );
    expect(disconnectMcp.status).toBe(200);
    expect((await callMcp(h, mcp.token)).status).toBe(401);
    expect(await apps(h, owner.cookie)).toEqual([]);
  });

  it("answers another user's app, an unknown client and a second disconnect like a missing one", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "apps-foreign@example.test");
    const intruder = await h.signIn("apps-foreign-intruder@example.test");
    const mcp = await connectMcp(h, owner.cookie);

    for (const clientId of [mcp.clientId, "portifact-cli", "no-such-client"]) {
      const response = await h.request(
        `/api/v1/account/apps/${encodeURIComponent(clientId)}`,
        dashboard(intruder, "DELETE"),
      );
      expect(response.status, clientId).toBe(404);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe("not_found");
    }
    expect((await callMcp(h, mcp.token)).status).toBe(200);
    expect((await callApi(h, mcp.token)).status).toBe(401);
  });
});

describe("account endpoint access", () => {
  const endpoints: [string, string][] = [
    ["GET", "/api/v1/account/sessions"],
    ["POST", "/api/v1/account/sessions/sign-out-others"],
    ["GET", "/api/v1/account/apps"],
    ["DELETE", "/api/v1/account/apps/portifact-cli"],
    ["GET", "/api/v1/account/export"],
    ["POST", "/api/v1/account/delete"],
  ];

  it("refuses session requests that do not come from the app's own pages", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "account-csrf@example.test");
    const variants: [string, (method: string) => RequestInit][] = [
      ["another site", (m) => dashboard(owner.cookie, m, { "sec-fetch-site": "cross-site" })],
      ["a sibling host", (m) => dashboard(owner.cookie, m, { "sec-fetch-site": "same-site" })],
      [
        "no fetch metadata",
        (m) => ({ method: m, headers: { cookie: owner.cookie, origin: ORIGIN } }),
      ],
    ];
    for (const [method, path] of endpoints) {
      for (const [label, init] of variants) {
        const response = await h.request(path, init(method));
        expect(response.status, `${method} ${path} from ${label}`).toBe(403);
      }
      if (method !== "GET") {
        for (const origin of [ARTIFACT_ORIGIN, "https://portifact.com", "null"]) {
          const response = await h.request(path, dashboard(owner.cookie, method, { origin }));
          expect(response.status, `${method} ${path} with Origin ${origin}`).toBe(403);
        }
      }
    }
    // Nothing was revoked or signed out by the refused requests.
    expect((await owner.call("/api/v1/me")).status).toBe(200);
    expect(await sessions(h, owner.cookie)).toHaveLength(1);
  });

  it("refuses bearer tokens, even ones with every scope and alongside a session cookie", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "account-bearer@example.test");
    for (const [method, path] of endpoints) {
      const plain = await owner.call(path, { method });
      expect(plain.status, `${method} ${path}`).toBe(403);
      const withCookie = await owner.call(path, dashboard(owner.cookie, method));
      expect(withCookie.status, `${method} ${path} with cookie`).toBe(403);
      expect(withCookie.headers.get("cache-control")).toBe("no-store");
    }
    expect((await owner.call("/api/v1/me")).status).toBe(200);
  });

  it("answers no session, a forged one and a signed-out one as unauthenticated", async () => {
    const h = createHarness();
    const cookie = await h.signIn("account-gone@example.test");
    await h.request("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    for (const [method, path] of endpoints) {
      for (const value of ["", cookie, `${SESSION_COOKIE}=forged.value`]) {
        const response = await h.request(path, dashboard(value, method));
        expect(response.status, `${method} ${path} with "${value.slice(0, 12)}"`).toBe(401);
        expect((await response.json<{ error: { code: string } }>()).error.code).toBe(
          "unauthenticated",
        );
      }
    }
  });
});
