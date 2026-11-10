// Questions 2 and 6: the SCIM plugin on D1, provisioning against the terms hook, and whether
// deprovisioning ends sessions through Better Auth so the session hooks run.
import { env } from "cloudflare:test";
import { createDb } from "@portifact/db";
import { beforeAll, describe, expect, it } from "vitest";
import type { SpikeAuthOptions } from "./auth.ts";
import { resolveActor } from "./membership.ts";
import { createHarness, get, json, newAccountCookies, uniqueEmail } from "./test/harness.ts";

const SCIM_TOKEN = "spike-scim-token-only-for-local-tests";
let workspaceId: string;

beforeAll(async () => {
  const h = createHarness();
  const admin = await h.signIn(uniqueEmail("admin"));
  const created = await h.raw(
    "/organization/create",
    json({ name: "Directory", slug: `dir-${crypto.randomUUID().slice(0, 6)}` }, { cookie: admin }),
  );
  workspaceId = ((await created.json()) as { id: string }).id;
});

function scimHarness(extra: SpikeAuthOptions = {}) {
  return createHarness({
    transactions: "sequential",
    scimConnections: [{ workspaceId, token: SCIM_TOKEN }],
    ...extra,
  });
}

function scimRequest(method: string, body?: unknown, token = SCIM_TOKEN): RequestInit {
  return {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function scimUser(email: string, active = true) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: email,
    externalId: `ext-${email}`,
    name: { givenName: "Grace", familyName: "Hopper" },
    emails: [{ value: email, primary: true, type: "work" }],
    active,
  };
}

describe("SCIM plugin on D1", () => {
  it("refuses to start with the Drizzle adapter as apps/app configures it", async () => {
    const h = createHarness({
      transactions: "none",
      scimConnections: [{ workspaceId, token: SCIM_TOKEN }],
    });
    await expect(h.raw("/scim/v2/ServiceProviderConfig", scimRequest("GET"))).rejects.toThrow(
      /requires a database adapter with native transaction support/,
    );
  });

  it("cannot write through Drizzle transactions, because D1 refuses BEGIN", async () => {
    const h = createHarness({
      transactions: "drizzle",
      scimConnections: [{ workspaceId, token: SCIM_TOKEN }],
    });
    const response = await h.gated(
      "/scim/v2/Users",
      scimRequest("POST", scimUser(uniqueEmail("tx"))),
    );
    expect(response.status).toBe(500);
  });

  it("serves discovery with a bearer token and refuses a wrong one", async () => {
    const h = scimHarness();
    expect((await h.gated("/scim/v2/ServiceProviderConfig", scimRequest("GET"))).status).toBe(200);
    expect(
      (await h.gated("/scim/v2/Users", scimRequest("GET", undefined, "wrong-token"))).status,
    ).toBe(401);
  });

  it("cannot provision a new user: SCIM creates it with an unverified email", async () => {
    const h = scimHarness();
    const email = uniqueEmail("provisioned");
    const response = await h.gated("/scim/v2/Users", scimRequest("POST", scimUser(email)));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { detail: string }).detail).toBe("email_not_verified");
    expect(
      await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first(),
    ).toBeNull();
  });

  it("cannot provision a new user even past that rule: nobody accepted the terms", async () => {
    const h = scimHarness({ trustScimEmails: true });
    const email = uniqueEmail("unaccepted");
    const response = await h.gated("/scim/v2/Users", scimRequest("POST", scimUser(email)));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { detail: string }).detail).toMatch(/terms/i);
    expect(
      await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first(),
    ).toBeNull();
  });

  it("refuses to provision an address that already has an account, without an explicit link", async () => {
    const h = scimHarness();
    const email = uniqueEmail("existing");
    await h.signIn(email);
    const response = await h.gated("/scim/v2/Users", scimRequest("POST", scimUser(email)));
    expect(response.status).toBe(409);
  });

  describe("with an explicit link to the existing account", () => {
    let h: ReturnType<typeof createHarness>;
    const ended: string[] = [];

    beforeAll(() => {
      h = createHarness({
        transactions: "sequential",
        scimConnections: [{ workspaceId, token: SCIM_TOKEN }],
        onSessionDeleted: (session) => ended.push(session.userId),
      });
    });

    it("adds the member, and deactivation removes it and ends sessions through Better Auth", async () => {
      // Linking by verified email is the application's call (identity.resolveUser); the spike
      // links through the plugin's projection instead: create the account first, then let the
      // directory provision the same address once Portifact has linked it.
      const email = uniqueEmail("linked");
      const cookie = await h.signIn(email);
      const userId = (
        (await (await h.raw("/get-session", get({ cookie }))).json()) as { user: { id: string } }
      ).user.id;
      const linked = createHarness({
        transactions: "sequential",
        scimConnections: [{ workspaceId, token: SCIM_TOKEN }],
        onSessionDeleted: (session) => ended.push(session.userId),
        scimLinkByVerifiedEmail: true,
      });
      const created = await linked.gated("/scim/v2/Users", scimRequest("POST", scimUser(email)));
      expect(created.status).toBe(201);
      const scimId = ((await created.json()) as { id: string }).id;
      expect((await resolveActor(createDb(env.DB), userId, workspaceId))?.role).toBe("member");

      const patched = await linked.gated(
        `/scim/v2/Users/${scimId}`,
        scimRequest("PATCH", {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        }),
      );
      expect(patched.status).toBe(200);
      expect(await resolveActor(createDb(env.DB), userId, workspaceId)).toBeNull();
      expect(ended).toContain(userId);
      const sessions = await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE user_id = ?")
        .bind(userId)
        .first<{ n: number }>();
      expect(sessions?.n).toBe(0);
    });

    it("creates, rather than links, when no verified account holds the address", async () => {
      const linked = createHarness({
        transactions: "sequential",
        scimConnections: [{ workspaceId, token: SCIM_TOKEN }],
        scimLinkByVerifiedEmail: true,
      });
      const unverified = uniqueEmail("unverified");
      await linked.signIn(unverified);
      await env.DB.prepare("UPDATE users SET email_verified = 0 WHERE email = ?")
        .bind(unverified)
        .run();
      // Not linked: the plugin tries to create and finds the address taken.
      expect(
        (await linked.gated("/scim/v2/Users", scimRequest("POST", scimUser(unverified)))).status,
      ).toBe(409);
      // Nobody holds it: the plugin creates, and Portifact's email rule refuses.
      expect(
        (await linked.gated("/scim/v2/Users", scimRequest("POST", scimUser(uniqueEmail("nobody")))))
          .status,
      ).toBe(403);
    });

    it("strips cookies, so a browser session never authenticates a SCIM call", async () => {
      const cookie = await h.signIn(uniqueEmail("browser"));
      const response = await h.gated("/scim/v2/Users", { method: "GET", headers: { cookie } });
      expect(response.status).toBe(401);
    });
  });

  it("requires a fresh terms acceptance at the first sign-in of an account created without one", async () => {
    const h = createHarness();
    const email = uniqueEmail("later");
    await h.signIn(email);
    await env.DB.prepare("UPDATE users SET terms_version = NULL WHERE email = ?").bind(email).run();
    await expect(h.signIn(email, "")).rejects.toThrow(/403/);
    await expect(h.signIn(email, await newAccountCookies({ human: false }))).resolves.toContain(
      "__Host-pf.session_token=",
    );
  });
});
