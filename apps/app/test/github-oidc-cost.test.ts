// What the GitHub OIDC exchange costs in D1 (decision 0024, "Costs"), pinned: one call for a
// refusal before the signature check, three for a verified token the workspace refuses, four for
// an issued credential; and a request with the credential costs what an admin's service token
// costs within its hour (no `last_used_at` write).
import { env } from "cloudflare:workers";
import { githubAudience } from "@portifact/contracts";
import { aliasBinding, regionsFromEnv, schema } from "@portifact/db";
import { createWorkspace } from "@portifact/services";
import { FakeGitHubIssuer } from "@portifact/services/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authUrls } from "../src/auth/config.ts";
import { clearGitHubKeyCache } from "../src/auth/github-oidc.ts";
import { createHarness, ORIGIN } from "./harness.ts";

const NOW = Date.parse("2026-11-11T09:00:00Z");
const REPO = { repositoryId: "8080", repositoryOwnerId: "90", repository: "acme/cost" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  clearGitHubKeyCache();
});
afterEach(() => {
  vi.useRealTimers();
});

/** `env.DB`, counting every D1 call: one statement run, or one batch. */
function recording(binding: D1Database) {
  let calls = 0;
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "bind") return (...args: unknown[]) => wrap(value.apply(target, args));
        if (["all", "raw", "run", "first"].includes(String(property))) {
          return (...args: unknown[]) => {
            calls += 1;
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
    real.set(wrapped, statement);
    return wrapped;
  };
  const proxy = new Proxy(binding, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          calls += 1;
          return target.batch(statements.map((s) => real.get(s) ?? s));
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    database: aliasBinding(proxy, binding),
    taken() {
      const seen = calls;
      calls = 0;
      return seen;
    },
  };
}

describe("the D1 cost of the GitHub OIDC exchange", () => {
  it("is pinned for each class of answer", async () => {
    const { database, taken } = recording(env.DB);
    const issuer = new FakeGitHubIssuer();
    const h = createHarness({ env: { DB: database }, githubOidcFetch: issuer.fetch });
    const cookie = await h.signIn("oidc-cost@example.test");
    const [admin] = await regionsFromEnv(env)
      .global.select({ id: schema.users.id })
      .from(schema.users)
      .where(eqEmail("oidc-cost@example.test"));
    if (!admin) throw new Error("no admin");
    const workspace = await createWorkspace(regionsFromEnv(env).global, {
      slug: "oidc-cost",
      name: "Cost",
      adminUserId: admin.id,
      now: NOW,
    });
    if (!workspace.ok) throw new Error(workspace.message);
    await regionsFromEnv(env).global.insert(schema.ownerPlans).values({
      ownerId: workspace.value.id,
      plan: "team",
      seats: 5,
      grantedBy: "test",
      updatedAt: NOW,
    });
    const dashboard = (method: string, body?: unknown): RequestInit => ({
      method,
      headers: {
        cookie,
        "sec-fetch-site": "same-origin",
        origin: ORIGIN,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const rule = await h.request(
      "/api/v1/workspaces/oidc-cost/github-trust",
      dashboard("POST", { ...REPO, events: ["pull_request"], scopes: ["artifacts:read"] }),
    );
    expect(rule.status).toBe(201);
    const token = await h.request(
      "/api/v1/workspaces/oidc-cost/service-tokens",
      dashboard("POST", {
        label: "Admin's",
        role: "editor",
        scopes: ["artifacts:read"],
        expiresInDays: 1,
      }),
    );
    const adminToken = (await token.json<{ secret: string }>()).secret;
    const audience = githubAudience(authUrls(env.APP_ORIGIN).origin, "oidc-cost");
    const exchange = (jwt: string) =>
      h.request("/api/v1/github/token", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.80" },
        body: JSON.stringify({ workspace: "oidc-cost", token: jwt }),
      });

    taken();
    expect((await exchange("not-a-token")).status).toBe(401);
    expect(taken(), "a refusal before the signature").toBe(1);
    const untrusted = await issuer.token({ ...REPO, repositoryId: "1" }, { audience });
    expect((await exchange(untrusted)).status).toBe(401);
    expect(taken(), "a verified token the workspace refuses").toBe(3);
    const issued = await exchange(await issuer.token(REPO, { audience }));
    expect(issued.status).toBe(200);
    expect(taken(), "an issued credential").toBe(4);

    const credential = (await issued.json<{ token: string }>()).token;
    const list = (secret: string) =>
      h.request("/api/v1/artifacts?workspace=oidc-cost", {
        headers: { authorization: `Bearer ${secret}` },
      });
    expect((await list(adminToken)).status).toBe(200);
    taken();
    expect((await list(adminToken)).status).toBe(200);
    const byToken = taken();
    expect((await list(credential)).status).toBe(200);
    expect(taken(), "a request with the credential").toBe(byToken);
  });
});

function eqEmail(email: string) {
  return eq(schema.users.email, email);
}
