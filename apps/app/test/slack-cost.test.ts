// What the Slack events endpoint costs (decision 0025, "Costs to pin in tests"), pinned with the
// D1 call counter of the GitHub OIDC cost test, over the default region (whose database is the
// global one) and an EU workspace (a separate regional database, with the strict region guard):
// nothing before the read; one read for every request that reaches it, refused or verified; the
// read and one guarded batch for the first request of a connection whose key the Worker lost and
// for an uninstall, and only the read after; one call to Slack to complete and one to remove.
import { env } from "cloudflare:workers";
import { aliasBinding, regionsFromEnv, schema } from "@portifact/db";
import { createWorkspace } from "@portifact/services";
import { FakeIssueTrackers, FakeSlack } from "@portifact/services/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";

const NOW = Date.parse("2026-11-12T09:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A D1 binding counting every call: one statement run, or one batch. */
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

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

interface Setup {
  h: Harness;
  fake: FakeSlack;
  /** Calls to both databases since the last look. */
  taken(): number;
  /** The connection's events path, signing secret and owner. */
  path: string;
  pendingPath: string;
  secret: string;
  ownerId: string;
  region: "default" | "eu";
  remove(): Promise<Response>;
}

async function setup(region: "default" | "eu", email: string): Promise<Setup> {
  const db = recording(env.DB);
  const eu = recording(env.DB_EU);
  const fake = new FakeSlack();
  const h = createHarness({
    env: { DB: db.database, DB_EU: eu.database },
    integrationFetch: fake.fetch,
  });
  const taken = () => db.taken() + eu.taken();
  const cookie = await h.signIn(email);
  const regions = regionsFromEnv(env);
  const [user] = await regions.global
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email));
  if (!user) throw new Error("no user");
  let ownerId = user.id;
  let query = "";
  if (region === "eu") {
    const slug = `slack-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createWorkspace(regions.global, {
      slug,
      name: "EU",
      adminUserId: user.id,
      now: NOW,
      region: "eu",
    });
    if (!created.ok) throw new Error(created.message);
    ownerId = created.value.id;
    query = `?workspace=${slug}`;
  }
  await regions.global
    .insert(schema.ownerPlans)
    .values({ ownerId, plan: "team", seats: 5, grantedBy: "test", updatedAt: NOW })
    .onConflictDoUpdate({ target: schema.ownerPlans.ownerId, set: { plan: "team" } });
  const session = (path: string, init: RequestInit) =>
    h.request(path, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        cookie,
        "sec-fetch-site": "same-origin",
        origin: ORIGIN,
      },
    });
  const start = async () =>
    (
      await session(
        `/api/v1/integrations/connections${query}`,
        json("POST", { service: "slack", label: "Acme" }),
      )
    ).json<{ id: string }>();
  const connection = await start();
  const pending = await start();
  const botToken = FakeSlack.botToken();
  const secret = FakeSlack.signingSecret();
  fake.bot(botToken, "Acme", "T0ACME01");
  taken();
  const before = fake.requests.length;
  const completed = await session(
    `/api/v1/integrations/connections/${connection.id}${query}`,
    json("PATCH", { botToken, signingSecret: secret }),
  );
  expect(completed.status).toBe(200);
  expect(fake.requests.length - before, "completing calls Slack once").toBe(1);
  taken();
  return {
    h,
    fake,
    taken,
    path: `/integrations/slack/events/${region}/${connection.id}`,
    pendingPath: `/integrations/slack/events/${region}/${pending.id}`,
    secret,
    ownerId,
    region,
    remove: () =>
      session(`/api/v1/integrations/connections/${connection.id}${query}`, { method: "DELETE" }),
  };
}

async function pinned(s: Setup) {
  const { h, fake, taken, path, secret } = s;
  const slackCalls = fake.requests.length;
  const verification = { type: "url_verification", challenge: "abc" };
  const good = await FakeSlack.signedEvent(secret, verification, { now: NOW });
  const headers = good.headers as Record<string, string>;
  const answers: string[] = [];
  const refused = async (label: string, request: Promise<Response>, calls: number) => {
    const answer = await request;
    expect(answer.status, label).toBe(401);
    answers.push(await answer.text());
    expect(taken(), label).toBe(calls);
  };

  // Refused before the read: no D1 call.
  await refused(
    "a stale timestamp",
    h.request(path, await FakeSlack.signedEvent(secret, verification, { timestamp: "1" })),
    0,
  );
  await refused(
    "a size over the cap",
    h.request(path, { ...good, headers: { ...headers, "content-length": "70000" } }),
    0,
  );
  await refused("a path that names nothing", h.request("/integrations/slack/events/x", good), 0);
  await refused(
    "another type",
    h.request(path, { ...good, headers: { ...headers, "content-type": "text/plain" } }),
    0,
  );

  // One read, and the same answer, for an unknown, a pending and a badly signed request.
  await refused(
    "an unknown connection",
    h.request(path.replace(/ic_[0-9a-f]+$/, `ic_${"7".repeat(32)}`), good),
    1,
  );
  await refused("a pending connection", h.request(s.pendingPath, good), 1);
  await refused(
    "a bad signature",
    h.request(
      path,
      await FakeSlack.signedEvent(FakeSlack.signingSecret(), verification, { now: NOW }),
    ),
    1,
  );
  expect(new Set(answers)).toEqual(new Set([""]));

  // Signed url_verification: one read.
  const verified = await h.request(path, good);
  expect(verified.status).toBe(200);
  expect(taken(), "a signed url_verification").toBe(1);

  // A link is acknowledged and ignored in this delivery: one read.
  const link = await h.request(
    path,
    await FakeSlack.signedEvent(
      secret,
      FakeSlack.event("T0ACME01", "link_shared", { links: [{ url: "https://x.portifact.dev/" }] }),
      { now: NOW },
    ),
  );
  expect(link.status).toBe(200);
  expect(taken(), "a link_shared event").toBe(1);

  // app_uninstalled twice: the read and one guarded batch, then only the read.
  const uninstall = await FakeSlack.signedEvent(
    secret,
    FakeSlack.event("T0ACME01", "app_uninstalled"),
    {
      now: NOW,
    },
  );
  expect((await h.request(path, uninstall)).status).toBe(200);
  expect(taken(), "the first app_uninstalled").toBe(2);
  expect((await h.request(path, uninstall)).status).toBe(200);
  expect(taken(), "a second app_uninstalled").toBe(1);

  // No request to the endpoint called Slack.
  expect(fake.requests.length).toBe(slackCalls);

  // Removing: one call to Slack (auth.revoke) after the answer.
  expect((await s.remove()).status).toBe(200);
  expect(fake.requests.length - slackCalls, "removing calls Slack once").toBe(1);
  expect(fake.requests.at(-1)?.url).toBe("https://slack.com/api/auth.revoke");
}

describe("the D1 cost of the Slack events endpoint", () => {
  it("is pinned for each class of request with one database", async () => {
    await pinned(await setup("default", "slack-cost@example.test"));
  });

  it("is the same with a separate regional database", async () => {
    await pinned(await setup("eu", "slack-cost-eu@example.test"));
  });

  it("marks a connection whose key the Worker lost once: the read and a batch, then the read", async () => {
    for (const region of ["default", "eu"] as const) {
      const s = await setup(region, `slack-cost-key-${region}@example.test`);
      const db = recording(env.DB);
      const eu = recording(env.DB_EU);
      const keyless = createHarness({
        env: {
          DB: db.database,
          DB_EU: eu.database,
          INTEGRATIONS_KEY: "another test-only key for the app suite, long enough",
        },
        integrationFetch: s.fake.fetch,
      });
      const request = async () =>
        keyless.request(
          s.path,
          await FakeSlack.signedEvent(
            s.secret,
            { type: "url_verification", challenge: "a" },
            {
              now: NOW,
            },
          ),
        );
      // A fresh harness seeds Better Auth's resources on its first request: not the endpoint's cost.
      await keyless.auth.$context;
      await keyless.request("/api/v1/me");
      db.taken();
      eu.taken();
      const first = await request();
      expect(first.status).toBe(401);
      expect(await first.text()).toBe("");
      expect(db.taken() + eu.taken(), `${region}: the first request`).toBe(2);
      const second = await request();
      expect(second.status).toBe(401);
      expect(db.taken() + eu.taken(), `${region}: a later request`).toBe(1);
      const failing = await (region === "eu"
        ? regionsFromEnv(env).get("eu").db
        : regionsFromEnv(env).get("default").db
      )
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.ownerId, s.ownerId));
      expect(failing.filter((e) => e.kind === "integration.failing").map((e) => e.detail)).toEqual([
        { service: "slack", reason: "key_unavailable" },
      ]);
    }
  });

  it("refuses an issue connection's ID for one read, opening nothing and writing nothing", async () => {
    const db = recording(env.DB);
    const token = `github_pat_slack_cost_${"0123456789".repeat(2)}`;
    const trackers = new FakeIssueTrackers().github(token, "octo-bot", ["acme/site"]);
    const h = createHarness({ env: { DB: db.database }, integrationFetch: trackers.fetch });
    const email = "slack-cost-github@example.test";
    const cookie = await h.signIn(email);
    const regions = regionsFromEnv(env);
    const [user] = await regions.global
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    if (!user) throw new Error("no user");
    await regions.global
      .insert(schema.ownerPlans)
      .values({ ownerId: user.id, plan: "team", seats: 1, grantedBy: "test", updatedAt: NOW });
    const created = await h.request("/api/v1/integrations/connections", {
      ...json("POST", {
        service: "github",
        label: "Repo",
        credential: token,
        targets: ["acme/site"],
      }),
      headers: {
        "content-type": "application/json",
        cookie,
        "sec-fetch-site": "same-origin",
        origin: ORIGIN,
      },
    });
    expect(created.status).toBe(201);
    const { id } = await created.json<{ id: string }>();
    const read = async () => {
      const [found] = await regions
        .get("default")
        .db.select()
        .from(schema.integrationConnections)
        .where(eq(schema.integrationConnections.id, id));
      const events = await regions
        .get("default")
        .db.select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.ownerId, user.id));
      return { found, events };
    };
    const before = await read();
    expect(before.found?.attention).toBeNull();
    db.taken();
    const path = `/integrations/slack/events/default/${id}`;
    const payload = { type: "url_verification", challenge: "abc" };
    for (const [label, init] of [
      [
        "unsigned",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": String(Math.floor(NOW / 1000)),
            "x-slack-signature": `v0=${"0".repeat(64)}`,
          },
          body: JSON.stringify(payload),
        },
      ],
      // Signed with a secret of the caller's choosing: an issue connection has none to match.
      ["signed", await FakeSlack.signedEvent(FakeSlack.signingSecret(), payload, { now: NOW })],
      [
        "signed with the token as the secret",
        await FakeSlack.signedEvent(token, payload, { now: NOW }),
      ],
    ] as const) {
      const answer = await h.request(path, init as RequestInit);
      expect(answer.status, label).toBe(401);
      expect(await answer.text(), label).toBe("");
      expect(db.taken(), label).toBe(1);
    }
    // Byte for byte as before: no attention, no event, nothing called.
    expect(await read()).toEqual(before);
    expect(trackers.requests.map((r) => r.url)).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/repos/acme/site",
    ]);
  });
});
