import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DOCUMENT_STYLESHEET } from "@portifact/render";
import { describe, expect, it } from "vitest";
import { SESSION_SCOPES } from "../src/api/access.ts";
import { dashboardCsp, PAGE_CSP } from "../src/app-host.ts";
import { publishSite, tokenClient } from "./api-client.ts";
import { createHarness, ORIGIN, SESSION_COOKIE } from "./harness.ts";

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

describe("dashboard pages", () => {
  it("sends visitors without a session to the login page, returning to where they were", async () => {
    const h = createHarness();
    for (const [path, next] of [
      ["/", "/"],
      ["/artifacts/k7d2qm4xab?tab=x", "/artifacts/k7d2qm4xab?tab=x"],
      ["/account", "/account"],
    ] as const) {
      const response = await h.request(path, { redirect: "manual" });
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location")).toBe(`/login?${new URLSearchParams({ next })}`);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const forged = await h.request("/", {
      redirect: "manual",
      headers: { cookie: `${SESSION_COOKIE}=forged.value` },
    });
    expect(forged.status).toBe(302);
  });

  it("serves the dashboard to a signed-in user with the strict page headers", async () => {
    const h = createHarness();
    const cookie = await h.signIn("dashboard-page@example.test");
    for (const path of [
      "/",
      "/publish",
      "/artifacts/k7d2qm4xab",
      "/artifacts/k7d2qm4xab/publish",
      "/artifacts/k7d2qm4xab/edit",
      "/artifacts/k7d2qm4xab/history",
      "/account",
    ]) {
      const response = await h.request(path, { headers: { cookie } });
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("content-security-policy")).toBe(await dashboardCsp(env));
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      const html = await response.text();
      expect(html).toContain('<div id="root"></div>');
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      const bundles = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
      expect(bundles.length).toBeGreaterThan(0);
      for (const bundle of bundles) {
        expect((await SELF.fetch(`${ORIGIN}${bundle}`)).status, bundle).toBe(200);
      }
    }
  });

  it("serves the dashboard only at its routes and only on the app host", async () => {
    const h = createHarness();
    const cookie = await h.signIn("dashboard-paths@example.test");
    for (const path of [
      "/dashboard",
      "/dashboard.html",
      "/artifacts",
      "/artifacts/a/b",
      "/account/x",
    ]) {
      expect((await h.request(path, { headers: { cookie } })).status, path).toBe(404);
    }
    for (const path of ["/dashboard", "/dashboard.html"]) {
      const response = await SELF.fetch(`https://portifact.com${path}`, { redirect: "manual" });
      expect(response.status, path).toBe(404);
    }
  });
});

describe("dashboard policy", () => {
  it("adds only the storage endpoint and the document stylesheet to the page policy", async () => {
    const policy = await dashboardCsp(env);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(DOCUMENT_STYLESHEET),
    );
    const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const storage = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    expect(policy).toBe(
      PAGE_CSP.replace("style-src 'self'", `style-src 'self' 'sha256-${hash}'`).replace(
        "connect-src 'self'",
        `connect-src 'self' ${storage}`,
      ),
    );
    // Frames, scripts and images stay as strict as the page policy: no other origin anywhere.
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain("img-src 'self';");
    expect(policy).not.toContain("frame-src");
    expect(policy).not.toContain("unsafe");
    expect(policy.match(/https:\/\/[^\s;]+/g)).toEqual([storage]);
  });
});

describe("dashboard session at /api/v1", () => {
  it("lists, reads and changes the user's artifacts with the session cookie", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "session-owner@example.test");
    const artifactId = await publishSite(owner, "Session plan");

    const list = await h.request("/api/v1/artifacts", dashboard(owner.cookie));
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const { items } = await list.json<{ items: { id: string; name: string }[] }>();
    expect(items.map((item) => item.id)).toEqual([artifactId]);

    const read = await h.request(`/api/v1/artifacts/${artifactId}`, dashboard(owner.cookie));
    expect((await read.json<{ name: string }>()).name).toBe("Session plan");

    for (const [action, state] of [
      ["archive", "archived"],
      ["restore", "active"],
      ["renew", "active"],
    ] as const) {
      const response = await h.request(
        `/api/v1/artifacts/${artifactId}/${action}`,
        dashboard(owner.cookie, "POST"),
      );
      expect(response.status, action).toBe(200);
      expect((await response.json<{ state: string }>()).state).toBe(state);
    }

    const deleted = await h.request(
      `/api/v1/artifacts/${artifactId}`,
      dashboard(owner.cookie, "DELETE"),
    );
    expect(deleted.status).toBe(200);
    expect((await deleted.json<{ state: string }>()).state).toBe("deleted");
  });

  it("answers another account's artifact like a missing one", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "session-a@example.test");
    const artifactId = await publishSite(owner);
    const other = await h.signIn("session-b@example.test");

    const read = await h.request(`/api/v1/artifacts/${artifactId}`, dashboard(other));
    expect(read.status).toBe(404);
    const archive = await h.request(
      `/api/v1/artifacts/${artifactId}/archive`,
      dashboard(other, "POST"),
    );
    expect(archive.status).toBe(404);
    const list = await h.request("/api/v1/artifacts", dashboard(other));
    expect((await list.json<{ items: unknown[] }>()).items).toEqual([]);
  });

  it("refuses session requests that do not come from the app's own pages", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "session-csrf@example.test");
    const artifactId = await publishSite(owner);
    const archive = `/api/v1/artifacts/${artifactId}/archive`;

    const refused: [string, RequestInit][] = [
      [
        "read from another site",
        dashboard(owner.cookie, "GET", { "sec-fetch-site": "cross-site" }),
      ],
      [
        "read from a sibling host",
        dashboard(owner.cookie, "GET", { "sec-fetch-site": "same-site" }),
      ],
      ["read without fetch metadata", { headers: { cookie: owner.cookie } }],
      ["mutation from an artifact", dashboard(owner.cookie, "POST", { origin: ARTIFACT_ORIGIN })],
      [
        "mutation from the landing",
        dashboard(owner.cookie, "POST", { origin: "https://portifact.com" }),
      ],
      ["mutation with a null origin", dashboard(owner.cookie, "POST", { origin: "null" })],
      [
        "mutation without an origin",
        { method: "POST", headers: { cookie: owner.cookie, "sec-fetch-site": "same-origin" } },
      ],
      [
        "mutation marked cross-site",
        dashboard(owner.cookie, "POST", { "sec-fetch-site": "cross-site" }),
      ],
    ];
    for (const [label, init] of refused) {
      const path = init.method === "POST" ? archive : "/api/v1/artifacts";
      const response = await h.request(path, init);
      expect(response.status, label).toBe(403);
      expect(await response.json(), label).toEqual({
        error: { code: "forbidden", message: "Cross-origin request refused." },
      });
    }
    const state = await (await owner.call(`/api/v1/artifacts/${artifactId}`)).json<{
      state: string;
    }>();
    expect(state.state).toBe("active");
  });

  it("answers an unknown, forged or signed-out session like no credentials", async () => {
    const h = createHarness();
    const cookie = await h.signIn("session-gone@example.test");
    await h.request("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    for (const value of [cookie, `${SESSION_COOKIE}=forged.value`]) {
      const response = await h.request("/api/v1/artifacts", dashboard(value));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
    }
  });

  it("matches the session cookie name exactly", async () => {
    const h = createHarness();
    const cookie = await h.signIn("session-case@example.test");
    const lowercased = cookie.replace(SESSION_COOKIE, SESSION_COOKIE.toLowerCase());
    const response = await h.request("/api/v1/artifacts", dashboard(lowercased));
    expect(response.status).toBe(401);
  });

  it("keeps bearer tokens working, and a token wins over a session cookie", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "bearer-owner@example.test");
    const artifactId = await publishSite(owner);
    const other = await h.signIn("bearer-other@example.test");

    const withToken = await owner.call("/api/v1/artifacts");
    expect(withToken.status).toBe(200);
    // The other user's cookie rides along, but the token decides who acts.
    const both = await owner.call(`/api/v1/artifacts/${artifactId}`, {
      headers: { cookie: other, "sec-fetch-site": "cross-site" },
    });
    expect(both.status).toBe(200);
    const badToken = await h.request("/api/v1/artifacts", {
      headers: { authorization: "Bearer not-a-token", ...dashboard(owner.cookie).headers },
    });
    expect(badToken.status).toBe(401);
  });

  it("keeps the token's scopes for bearer requests while sessions hold every product scope", async () => {
    const h = createHarness();
    const reader = await tokenClient(h, "bearer-reader@example.test", "artifacts:read");
    const artifactId = await publishSite(await tokenClient(h, "bearer-reader@example.test"));
    const denied = await reader.call(`/api/v1/artifacts/${artifactId}`, { method: "DELETE" });
    expect(denied.status).toBe(403);
    const viaSession = await h.request(
      `/api/v1/artifacts/${artifactId}`,
      dashboard(reader.cookie, "DELETE"),
    );
    expect(viaSession.status).toBe(200);
    expect(SESSION_SCOPES).toEqual(
      expect.arrayContaining(["artifacts:read", "artifacts:write", "artifacts:delete"]),
    );
  });
});
