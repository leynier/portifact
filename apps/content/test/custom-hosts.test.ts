// Serving on custom hosts (decision 0006, sections 5 and 6): the switch, the cached hint checked
// against `artifacts.custom_host` on every request, the canonical redirect of old `.dev` links,
// the `http` upgrade without HSTS, codes bound to their host, host-only cookies, the cleanup of
// injected cookies only on the content domain, and traffic, views and openings charged the same.
import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import {
  createShareLink,
  issueReadHandoff,
  issueReviewHandoff,
  openShareLink,
} from "@portifact/services";
import { beforeEach, describe, expect, it } from "vitest";
import type { Opening } from "../src/access-log.ts";
import { HostDirectory, isolateHosts, resolveCustomHost } from "../src/custom-hosts.ts";
import { type Env, handle } from "../src/index.ts";
import type { TrafficCharge } from "../src/traffic.ts";
import type { ViewCharge } from "../src/views.ts";

const ID = "c7d2qm4xab";
const OTHER_ID = "c3n5wq7yzc";
const DEV = `${ID}.portifact.dev`;
const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
const PAGE = "<h1>Handbook</h1>";
const OWNER = "u_domain_owner";
const READER = "u_domain_reader";
const db = () => regionsFromEnv(env).get("default").db;
/** Raw SQL for the changes the services and jobs would make. */
const run = (query: string, ...values: unknown[]) =>
  env.DB.prepare(query)
    .bind(...values)
    .run();
const ON: Env = { ...(env as Env), CUSTOM_DOMAINS_ENABLED: "true" };
let counter = 0;
const host = () => `docs${++counter}.example-${crypto.randomUUID().slice(0, 6)}.com`;

async function seed(overrides: Partial<typeof schema.artifacts.$inferInsert> = {}) {
  for (const table of [
    "custom_domains",
    "share_sessions",
    "share_handoffs",
    "share_links",
    "review_sessions",
    "review_handoffs",
    "traffic_counters",
    "read_sessions",
    "read_handoffs",
    "artifact_readers",
    "version_files",
    "versions",
    "objects",
    "artifacts",
    "owner_plans",
    "sessions",
    "users",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const at = new Date(NOW - 30 * DAY);
  await db()
    .insert(schema.users)
    .values(
      [OWNER, READER].map((id) => ({
        id,
        name: id,
        email: `${id}@example.com`,
        emailVerified: true,
        createdAt: at,
        updatedAt: at,
      })),
    );
  for (const user of [OWNER, READER]) {
    await db()
      .insert(schema.sessions)
      .values({
        id: `as_${user}`,
        token: `token-${user}`,
        userId: user,
        expiresAt: new Date(NOW + 7 * DAY),
        createdAt: at,
        updatedAt: at,
      });
  }
  await db()
    .insert(schema.ownerPlans)
    .values({ ownerId: OWNER, plan: "pro", seats: 1, grantedBy: "test", updatedAt: NOW });
  const hash = "c".repeat(64);
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
        name: "Handbook",
        state: "active",
        accessMode: "public",
        currentVersionId: `${id}-v1`,
        expiresAt: NOW + 10 * DAY,
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
  await db()
    .insert(schema.artifactReaders)
    .values({ artifactId: ID, email: `${READER}@example.com` });
}

/** An active custom domain of the artifact, as the jobs would leave it. */
async function attach(hostname: string, artifactId = ID) {
  await db()
    .insert(schema.customDomains)
    .values({
      hostname,
      ownerId: OWNER,
      artifactId,
      region: "default",
      state: "active",
      token: "a".repeat(32),
      cfHostnameId: "cf-id",
      verifiedAt: NOW,
      checkedAt: NOW,
    });
  await run("UPDATE artifacts SET custom_host = ? WHERE id = ?", hostname, artifactId);
}

/** What a detach leaves: the artifact cleared first, the row on its way out. */
async function detach(hostname: string) {
  await run("UPDATE artifacts SET custom_host = NULL WHERE custom_host = ?", hostname);
  await run("UPDATE custom_domains SET state = 'detaching' WHERE hostname = ?", hostname);
}

const NAVIGATE = {
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};
const SUBRESOURCE = {
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Dest": "script",
};
const FRAME = {
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "iframe",
};
const FROM_APP = {
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};

interface Send {
  headers?: Record<string, string>;
  cookie?: string | undefined;
  env?: Env;
  traffic?: TrafficCharge[];
  openings?: Opening[];
  views?: ViewCharge[];
}

function send(url: string, options: Send = {}) {
  const headers = new Headers(options.headers ?? NAVIGATE);
  if (options.cookie) headers.set("Cookie", options.cookie);
  return handle(
    new Request(url, { headers }),
    options.env ?? ON,
    NOW,
    (charge) => options.traffic?.push(charge),
    (opening) => options.openings?.push(opening),
    (view) => options.views?.push(view),
  );
}

async function snapshot(response: Response) {
  const headers = [...response.headers].filter(([name]) => name !== "date");
  return { status: response.status, headers, body: await response.text() };
}

describe("custom domains switched off", () => {
  beforeEach(() => seed());

  it("answers every other host 404 and serves `.dev` exactly as before a domain existed", async () => {
    const before = await snapshot(await send(`https://${DEV}/`, { env: env as Env }));
    const hostname = host();
    await attach(hostname);
    expect((await send(`https://${hostname}/`, { env: env as Env })).status).toBe(404);
    expect((await send(`http://${hostname}/`, { env: env as Env })).status).toBe(404);
    const after = await snapshot(await send(`https://${DEV}/`, { env: env as Env }));
    expect(after).toEqual(before);
    expect(after.status).toBe(200);
  });
});

describe("serving on a custom host", () => {
  beforeEach(() => seed());

  it("serves the artifact with the same headers, charges its owner and counts one view", async () => {
    const hostname = host();
    await attach(hostname);
    const traffic: TrafficCharge[] = [];
    const views: ViewCharge[] = [];
    const response = await send(`https://${hostname}/`, { traffic, views });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAGE);
    expect(response.headers.get("Strict-Transport-Security")).toBeNull();
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'self' https://app.portifact.com",
    );
    expect(traffic).toEqual([
      { ownerId: OWNER, cycleStart: expect.any(Number), bytes: PAGE.length },
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ artifactId: ID, ownerId: OWNER });
  });

  it("upgrades plain http itself, with no HSTS on the customer's domain", async () => {
    const hostname = host();
    await attach(hostname);
    const response = await send(`http://${hostname}/guide?x=1`);
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe(`https://${hostname}/guide?x=1`);
    expect(response.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("answers an unknown or detached host 404 at the next request, and caches no miss", async () => {
    const hostname = host();
    expect((await send(`https://${hostname}/`)).status).toBe(404);
    await attach(hostname);
    expect((await send(`https://${hostname}/`)).status).toBe(200);
    await detach(hostname);
    expect((await send(`https://${hostname}/`)).status).toBe(404);
    // Names that are not custom domains never reach the table.
    for (const name of ["portifact.dev", "domains.portifact.dev", "localhost", "127.0.0.1"]) {
      expect((await send(`https://${name}/`)).status, name).toBe(404);
    }
  });

  it("follows a host that moved to another artifact on the first request after the move", async () => {
    const hostname = host();
    await attach(hostname);
    expect((await send(`https://${hostname}/`)).status).toBe(200);
    // The name moves: the old artifact stops holding it first, then the row and the new artifact.
    await run("UPDATE artifacts SET custom_host = NULL WHERE id = ?", ID);
    await run("UPDATE custom_domains SET artifact_id = ? WHERE hostname = ?", OTHER_ID, hostname);
    await run("UPDATE artifacts SET custom_host = ? WHERE id = ?", hostname, OTHER_ID);
    const views: ViewCharge[] = [];
    expect((await send(`https://${hostname}/`, { views })).status).toBe(200);
    expect(views[0]?.artifactId).toBe(OTHER_ID);
  });

  it("serves a global row alone nothing: the artifact must hold the host", async () => {
    const hostname = host();
    await attach(hostname);
    await run("UPDATE artifacts SET custom_host = NULL WHERE id = ?", ID);
    expect((await send(`https://${hostname}/`)).status).toBe(404);
  });

  it("answers Portifact's own scripts and the report link on the custom host", async () => {
    const hostname = host();
    await attach(hostname);
    expect(
      (await send(`https://${hostname}/__portifact/bridge.js`, { headers: SUBRESOURCE })).status,
    ).toBe(200);
    const report = await send(`https://${hostname}/__portifact/report`);
    expect(report.status).toBe(303);
    expect(report.headers.get("Location")).toBe(`https://app.portifact.com/report?artifact=${ID}`);
  });

  it("sends a top-level page visit to the viewer while the bar is on", async () => {
    await seed({ bar: true });
    const hostname = host();
    await attach(hostname);
    const response = await send(`https://${hostname}/index.html?x=1`);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(
      `https://app.portifact.com/view/${ID}?path=%2Findex.html%3Fx%3D1`,
    );
    // The viewer's frame gets the page.
    expect((await send(`https://${hostname}/`, { headers: FRAME })).status).toBe(200);
  });
});

describe("old `.dev` links", () => {
  beforeEach(() => seed());

  it("send a top-level page visit to the custom host with the same path, only with the bar off", async () => {
    const hostname = host();
    await attach(hostname);
    const traffic: TrafficCharge[] = [];
    const views: ViewCharge[] = [];
    const openings: Opening[] = [];
    const response = await send(`https://${DEV}/index.html?x=1`, { traffic, views, openings });
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe(`https://${hostname}/index.html?x=1`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // Charged as one request without bytes; the visit it leads to is the view.
    expect(traffic).toEqual([{ ownerId: OWNER, cycleStart: expect.any(Number), bytes: 0 }]);
    expect(views).toEqual([]);
    expect(openings).toEqual([]);
  });

  it("keep serving frames, subresources, files and the bar's viewer as before", async () => {
    const hostname = host();
    await attach(hostname);
    expect((await send(`https://${DEV}/`, { headers: FRAME })).status).toBe(200);
    expect((await send(`https://${DEV}/app.js`, { headers: SUBRESOURCE })).status).toBe(200);
    // With the bar on the viewer wins; it frames the custom host itself.
    await run("UPDATE artifacts SET bar = 1 WHERE id = ?", ID);
    const viewer = await send(`https://${DEV}/`);
    expect(viewer.status).toBe(303);
    expect(viewer.headers.get("Location")).toBe(`https://app.portifact.com/view/${ID}`);
    // A visitor who asked for no bar on `.dev` stays there.
    expect((await send(`https://${DEV}/`, { cookie: "__Host-pf_nobar=1" })).status).toBe(200);
  });

  it("never tell an anonymous visitor of a protected artifact its domain", async () => {
    await seed({ accessMode: "restricted" });
    const hostname = host();
    await attach(hostname);
    const response = await send(`https://${DEV}/`);
    expect(response.status).toBe(303);
    const location = response.headers.get("Location") ?? "";
    expect(location.startsWith(`https://app.portifact.com/read/${ID}?state=`)).toBe(true);
    expect(location).not.toContain(hostname);
    expect(location).not.toContain("host=");
  });

  it("stop redirecting at the next request once the domain is detached", async () => {
    const hostname = host();
    await attach(hostname);
    expect((await send(`https://${DEV}/`)).status).toBe(308);
    await detach(hostname);
    expect((await send(`https://${DEV}/`)).status).toBe(200);
  });
});

describe("sessions on a custom host", () => {
  beforeEach(() => seed({ accessMode: "restricted" }));

  /** Starts sign-in on `origin` and returns the transaction cookie and the app's entry URL. */
  async function startSignIn(origin: string) {
    const response = await send(`${origin}/guide`);
    const location = new URL(response.headers.get("Location") ?? "");
    const cookie =
      response.headers.getSetCookie().find((c) => c.startsWith("__Host-pf_read_tx_")) ?? "";
    return { location, cookie, state: location.searchParams.get("state") ?? "" };
  }

  it("starts sign-in with the host, and a code redeems only on the host it was issued for", async () => {
    const hostname = host();
    await attach(hostname);
    const custom = await startSignIn(`https://${hostname}`);
    expect(custom.location.searchParams.get("host")).toBe(hostname);
    // Host-only: no Domain attribute, the `__Host-` prefix.
    expect(custom.cookie).not.toMatch(/Domain=/i);
    expect(custom.cookie).toMatch(/; Path=\/; Secure/);

    const issue = async (requestedHost: string | null) =>
      issueReadHandoff(db(), {
        artifactId: ID,
        userId: READER,
        authSessionId: `as_${READER}`,
        state: custom.state,
        now: NOW,
        requestedHost,
        contentDomain: "portifact.dev",
      });
    const forDev = await issue(null);
    if (!forDev.ok) throw new Error(forDev.message);
    const transaction = custom.cookie.split(";")[0] as string;
    // A code sent to `.dev` does nothing on the custom host.
    const refused = await send(
      `https://${hostname}/__portifact/callback?code=${forDev.value.code}`,
      {
        headers: FROM_APP,
        cookie: transaction,
      },
    );
    expect(refused.status).toBe(400);
    const forCustom = await issue(hostname);
    if (!forCustom.ok) throw new Error(forCustom.message);
    const redeemed = await send(
      `https://${hostname}/__portifact/callback?code=${forCustom.value.code}`,
      {
        headers: FROM_APP,
        cookie: transaction,
      },
    );
    expect(redeemed.status).toBe(303);
    expect(redeemed.headers.get("Location")).toBe(`https://${hostname}/guide`);
    const session = redeemed.headers.getSetCookie().find((c) => c.startsWith("__Host-pf_read="));
    expect(session).toBeDefined();
    expect(session).not.toMatch(/Domain=/i);
    // The session reads the artifact on the custom host.
    const page = await send(`https://${hostname}/`, { cookie: (session as string).split(";")[0] });
    expect(page.status).toBe(200);
  });

  it("binds review codes and share-link codes to their host", async () => {
    const hostname = host();
    await attach(hostname);
    const review = await issueReviewHandoff(db(), {
      artifactId: ID,
      userId: READER,
      authSessionId: `as_${READER}`,
      now: NOW,
      contentDomain: "portifact.dev",
    });
    if (!review.ok) throw new Error(review.message);
    expect(review.value.host).toBe(hostname);
    const onDev = await send(`https://${DEV}/__portifact/review?code=${review.value.code}`, {
      headers: FRAME,
    });
    expect(onDev.status).toBe(400);
    const onCustom = await send(
      `https://${hostname}/__portifact/review?code=${review.value.code}`,
      {
        headers: FRAME,
      },
    );
    expect(onCustom.status).toBe(303);
    expect(onCustom.headers.get("Location")).toBe(`https://${hostname}/__portifact/review/check`);

    const created = await createShareLink(db(), {
      userId: OWNER,
      artifactId: ID,
      label: "Board",
      expiresAt: null,
      now: NOW,
    });
    if (!created.ok) throw new Error(created.message);
    const opened = await openShareLink([db()], {
      token: created.value.token,
      now: NOW,
      contentDomain: "portifact.dev",
    });
    if (opened.kind !== "opened") throw new Error(opened.kind);
    expect(opened.host).toBe(hostname);
    expect(
      (await send(`https://${DEV}/__portifact/link?code=${opened.code}`, { headers: FROM_APP }))
        .status,
    ).toBe(400);
    const linked = await send(`https://${hostname}/__portifact/link?code=${opened.code}`, {
      headers: FROM_APP,
    });
    expect(linked.status).toBe(303);
    const cookie = linked.headers.getSetCookie().find((c) => c.startsWith("__Host-pf_link="));
    expect(cookie).not.toMatch(/Domain=/i);
    // A link session on the custom host gets the artifact itself, never a redirect.
    const page = await send(`https://${hostname}/`, { cookie: (cookie as string).split(";")[0] });
    expect(page.status).toBe(200);
  });

  it("lets cookies the customer's other sites set grant nothing, and never expires them", async () => {
    const hostname = host();
    await attach(hostname);
    const big = Array.from({ length: 12 }, (_, i) => `pf_read${i}=${"x".repeat(1000)}`).join("; ");
    const custom = await send(`https://${hostname}/`, { cookie: big });
    // Not allowed in: sign-in starts, as with no cookie.
    expect(custom.status).toBe(303);
    expect(custom.headers.getSetCookie().some((c) => /Domain=/i.test(c))).toBe(false);
    // On `.dev` the same cookies are expired on the content domain.
    const dev = await send(`https://${DEV}/`, { cookie: big });
    expect(dev.headers.getSetCookie().some((c) => c.includes("Domain=portifact.dev"))).toBe(true);
  });
});

describe("the hint cache", () => {
  beforeEach(() => seed());

  it("costs one artifact read warm, reads the table on a cold or stale hint, and forgets misses", async () => {
    const regions = regionsFromEnv(env);
    const hosts = new HostDirectory(2);
    const hostname = host();
    expect(await resolveCustomHost(regions, hosts, hostname, NOW)).toBeNull();
    expect(hosts.size).toBe(0);
    await attach(hostname);
    expect((await resolveCustomHost(regions, hosts, hostname, NOW))?.artifact.id).toBe(ID);
    expect(hosts.cached(hostname)).toEqual({ artifactId: ID, region: "default" });
    // A stale hint (the row left) is dropped on the same request.
    await detach(hostname);
    expect(await resolveCustomHost(regions, hosts, hostname, NOW)).toBeNull();
    expect(hosts.cached(hostname)).toBeUndefined();
    // The oldest entries go past the cache's size.
    const names = [host(), host(), host()];
    for (const name of names) {
      await run("DELETE FROM custom_domains");
      await run("UPDATE artifacts SET custom_host = NULL");
      await attach(name);
      await resolveCustomHost(regions, hosts, name, NOW);
    }
    expect(hosts.size).toBe(2);
    expect(hosts.cached(names[0] as string)).toBeUndefined();
    expect(isolateHosts()).toBe(isolateHosts());
  });
});
