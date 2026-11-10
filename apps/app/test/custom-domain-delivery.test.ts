// The app's part of serving on custom hosts (decision 0006, section 6): the read entry sends a
// code only to the artifact's `.dev` host or its active custom host from the tables; the review
// code, the viewer's lookup and the viewer page's `frame-src` name the custom host only for a
// visitor who may read the artifact, so a missing or protected artifact's answers are the same
// with or without a domain; share links open on the custom host; artifact views carry it.
import { env } from "cloudflare:workers";
import { regionsFromEnv, schema } from "@portifact/db";
import { FakeDomains } from "@portifact/services/testing";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { viewerCsp } from "../src/app-host.ts";
import { UNAVAILABLE_URL } from "../src/read.ts";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";

const ID = "k7d2qm4xbc";
const HOST = "docs.custom-example.com";
const DEV = `https://${ID}.portifact.dev`;
const STATE = "n".repeat(43);
const DAY = 86_400_000;
const db = () => regionsFromEnv(env).get("default").db;

const OWNER = "domain-owner@example.com";
const READER = "domain-reader@example.com";
const STRANGER = "domain-stranger@example.com";

let on: Harness;
let off: Harness;
const cookies: Record<string, string> = {};

async function userId(email: string): Promise<string> {
  const [user] = await db().select().from(schema.users).where(eq(schema.users.email, email));
  if (!user) throw new Error(`no user ${email}`);
  return user.id;
}

async function seed(accessMode: "public" | "restricted" | "authenticated", withDomain: boolean) {
  for (const table of ["custom_domains", "read_handoffs", "review_handoffs", "artifact_readers"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  await env.DB.prepare("DELETE FROM artifacts WHERE id = ?").bind(ID).run();
  const ownerId = await userId(OWNER);
  await db()
    .insert(schema.artifacts)
    .values({
      id: ID,
      ownerId,
      type: "site",
      name: "Handbook",
      state: "active",
      accessMode,
      currentVersionId: `${ID}-v1`,
      expiresAt: Date.now() + 10 * DAY,
      customHost: withDomain ? HOST : null,
    });
  await db()
    .insert(schema.versions)
    .values({
      id: `${ID}-v1`,
      artifactId: ID,
      number: 1,
      authorId: ownerId,
      entrypoint: "index.html",
      publishedBytes: 10,
    })
    .onConflictDoNothing();
  await db().insert(schema.artifactReaders).values({ artifactId: ID, email: READER });
  if (withDomain) {
    await db()
      .insert(schema.customDomains)
      .values({
        hostname: HOST,
        ownerId,
        artifactId: ID,
        region: "default",
        state: "active",
        token: "a".repeat(32),
        cfHostnameId: "cf-id",
        verifiedAt: Date.now(),
        checkedAt: Date.now(),
      });
  }
}

const get = (h: Harness, path: string, cookie?: string, extra: Record<string, string> = {}) =>
  h.request(path, { headers: { ...(cookie ? { cookie } : {}), ...extra }, redirect: "manual" });

beforeAll(async () => {
  on = createHarness({ domains: new FakeDomains(), env: { CUSTOM_DOMAINS_ENABLED: "true" } });
  off = createHarness();
  for (const email of [OWNER, READER, STRANGER]) cookies[email] = await on.signIn(email);
});

describe("the read entry", () => {
  beforeEach(() => seed("restricted", true));

  it("sends the code back to the custom host the visitor started on, bound to it", async () => {
    const response = await get(on, `/read/${ID}?state=${STATE}&host=${HOST}`, cookies[READER]);
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(`https://${HOST}/__portifact/callback`);
    const [handoff] = await db().select().from(schema.readHandoffs);
    expect(handoff?.host).toBe(HOST);
    // Without a host, the `.dev` origin as always.
    const dev = await get(on, `/read/${ID}?state=${"m".repeat(43)}`, cookies[READER]);
    expect(new URL(dev.headers.get("location") ?? "").origin).toBe(DEV);
  });

  it("answers any other host like an artifact the visitor cannot open, revealing nothing", async () => {
    const forbidden = await get(on, `/read/${ID}?state=${STATE}`, cookies[STRANGER]);
    expect(forbidden.headers.get("location")).toBe(UNAVAILABLE_URL);
    for (const host of ["evil.example.com", `${ID}.portifact.dev`, "DOCS.custom-example.com"]) {
      const response = await get(on, `/read/${ID}?state=${STATE}&host=${host}`, cookies[READER]);
      expect(response.headers.get("location"), host).toBe(UNAVAILABLE_URL);
    }
    // Two hosts are refused too, and a stranger asking for the right host learns nothing more.
    expect(
      (
        await get(on, `/read/${ID}?state=${STATE}&host=${HOST}&host=${HOST}`, cookies[READER])
      ).headers.get("location"),
    ).toBe(UNAVAILABLE_URL);
    expect(
      (await get(on, `/read/${ID}?state=${STATE}&host=${HOST}`, cookies[STRANGER])).headers.get(
        "location",
      ),
    ).toBe(UNAVAILABLE_URL);
    expect(await db().select().from(schema.readHandoffs)).toEqual([]);
  });

  it("keeps the host through sign-in", async () => {
    const response = await get(on, `/read/${ID}?state=${STATE}&host=${HOST}`);
    const location = new URL(response.headers.get("location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe(`/read/${ID}?state=${STATE}&host=${HOST}`);
  });
});

describe("the viewer and review mode", () => {
  const viewerApi = (h: Harness, cookie?: string) =>
    get(h, `/api/v1/artifacts/${ID}/viewer`, cookie, { "sec-fetch-site": "same-origin" });
  const reviewStart = (cookie: string) =>
    on.request(`/api/v1/artifacts/${ID}/review`, {
      method: "POST",
      headers: { cookie, "sec-fetch-site": "same-origin", origin: ORIGIN },
    });

  it("frames the custom host for a reader, in the lookup, the review code and the page's policy", async () => {
    await seed("restricted", true);
    const info = await (await viewerApi(on, cookies[READER])).json<{ origin: string }>();
    expect(info.origin).toBe(`https://${HOST}`);
    const review = await (await reviewStart(cookies[READER] as string)).json<{
      url: string;
      origin: string;
    }>();
    expect(review.origin).toBe(`https://${HOST}`);
    expect(new URL(review.url).host).toBe(HOST);
    const page = await get(on, `/view/${ID}`, cookies[READER]);
    expect(page.headers.get("content-security-policy")).toBe(
      await viewerCsp(env, ID, `https://${HOST}`),
    );
    expect(page.headers.get("content-security-policy")).toContain(`frame-src https://${HOST} `);
  });

  it("gives a visitor who may not read the same page with or without a domain", async () => {
    const pages = async () => {
      const result: (string | null)[] = [];
      for (const cookie of [undefined, cookies[STRANGER]]) {
        result.push((await get(on, `/view/${ID}`, cookie)).headers.get("content-security-policy"));
        result.push(
          (await get(on, `/view/abcdefghij`, cookie)).headers
            .get("content-security-policy")
            ?.replace("abcdefghij", ID) ?? null,
        );
      }
      return result;
    };
    await seed("restricted", false);
    const without = await pages();
    await seed("restricted", true);
    const withDomain = await pages();
    expect(withDomain).toEqual(without);
    expect(withDomain[0]).toBe(await viewerCsp(env, ID));
    expect(withDomain[0]).not.toContain(HOST);
    // The lookup answers them 404 alike.
    expect((await viewerApi(on)).status).toBe(404);
    expect((await viewerApi(on, cookies[STRANGER])).status).toBe(404);
  });

  it("frames the custom host of a public artifact for anyone, signed in or not", async () => {
    await seed("public", true);
    const page = await get(on, `/view/${ID}`);
    expect(page.headers.get("content-security-policy")).toContain(`frame-src https://${HOST} `);
    const info = await (await viewerApi(on)).json<{ origin: string }>();
    expect(info.origin).toBe(`https://${HOST}`);
  });

  it("keeps the `.dev` origin while custom domains are switched off", async () => {
    await seed("public", true);
    const page = await get(off, `/view/${ID}`);
    expect(page.headers.get("content-security-policy")).toBe(await viewerCsp(env, ID));
  });
});

describe("artifact views", () => {
  it("give the custom host and the address to use while one is active", async () => {
    await seed("public", true);
    const { apiToken, api } = await import("./mcp-helpers.ts");
    const token = await apiToken(on, OWNER, "artifacts:read offline_access");
    const one = await (await api(on, token, `/api/v1/artifacts/${ID}`)).json<{
      url: string;
      customHost?: string;
    }>();
    expect(one).toMatchObject({ url: `https://${HOST}/`, customHost: HOST });
    const list = await (await api(on, token, "/api/v1/artifacts")).json<{
      items: { id: string; url: string; customHost?: string }[];
    }>();
    expect(list.items.find((item) => item.id === ID)).toMatchObject({
      url: `https://${HOST}/`,
      customHost: HOST,
    });
    await seed("public", false);
    const plain = await (await api(on, token, `/api/v1/artifacts/${ID}`)).json<
      Record<string, unknown>
    >();
    expect(plain.url).toBe(`${DEV}/`);
    expect("customHost" in plain).toBe(false);
  });
});

describe("the switch", () => {
  const origins = async (h: Harness) => {
    const viewer = await (
      await get(h, `/api/v1/artifacts/${ID}/viewer`, cookies[READER], {
        "sec-fetch-site": "same-origin",
      })
    ).json<{ origin: string }>();
    const review = await (
      await h.request(`/api/v1/artifacts/${ID}/review`, {
        method: "POST",
        headers: {
          cookie: cookies[READER] as string,
          "sec-fetch-site": "same-origin",
          origin: ORIGIN,
        },
      })
    ).json<{ origin: string; url: string }>();
    const page = await get(h, `/view/${ID}`, cookies[READER]);
    return {
      viewer: viewer.origin,
      review: review.origin,
      reviewUrl: new URL(review.url).origin,
      frame: page.headers.get("content-security-policy")?.includes(`frame-src https://${HOST} `),
    };
  };

  it("names only `.dev` while off, even with Cloudflare configured and an active domain, and again after a rollback", async () => {
    await seed("restricted", true);
    // Cloudflare's clients are there; only the variable is missing.
    const unset = createHarness({ domains: new FakeDomains() });
    const custom = `https://${HOST}`;
    const onHosts = { viewer: custom, review: custom, reviewUrl: custom, frame: true };
    const offHosts = { viewer: DEV, review: DEV, reviewUrl: DEV, frame: false };
    expect(await origins(on)).toEqual(onHosts);
    expect(await origins(unset)).toEqual(offHosts);
    expect(await origins(off)).toEqual(offHosts);
    expect(await origins(on)).toEqual(onHosts);
    // The read entry refuses the custom host while off, like any host that is not the artifact's.
    const read = await get(unset, `/read/${ID}?state=${STATE}&host=${HOST}`, cookies[READER]);
    expect(read.headers.get("location")).toBe(UNAVAILABLE_URL);
  });

  it("serves the domains that exist with the variable alone, as the content Worker does", async () => {
    await seed("restricted", true);
    const servingOnly = createHarness({ env: { CUSTOM_DOMAINS_ENABLED: "true" } });
    const custom = `https://${HOST}`;
    expect(await origins(servingOnly)).toEqual({
      viewer: custom,
      review: custom,
      reviewUrl: custom,
      frame: true,
    });
  });
});

describe("an artifact every signed-in account reads", () => {
  beforeEach(() => seed("authenticated", true));

  const confirm = (headers: Record<string, string>, body: unknown = { state: STATE, host: HOST }) =>
    on.request(`/read/${ID}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("asks for a click before a read code goes to the custom host", async () => {
    const response = await get(on, `/read/${ID}?state=${STATE}&host=${HOST}`, cookies[STRANGER]);
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("confirm")).toBe("read");
    expect(location.searchParams.get("next")).toBe(`/read/${ID}?state=${STATE}&host=${HOST}`);
    expect(await db().select().from(schema.readHandoffs)).toEqual([]);

    const confirmed = await confirm({
      cookie: cookies[STRANGER] as string,
      "sec-fetch-site": "same-origin",
      origin: ORIGIN,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get("cache-control")).toBe("no-store");
    const { url } = await confirmed.json<{ url: string }>();
    const callback = new URL(url);
    expect(`${callback.origin}${callback.pathname}`).toBe(`https://${HOST}/__portifact/callback`);
    const [handoff] = await db().select().from(schema.readHandoffs);
    expect(handoff?.host).toBe(HOST);
    // The `.dev` entry needs no click.
    const dev = await get(on, `/read/${ID}?state=${"m".repeat(43)}`, cookies[STRANGER]);
    expect(new URL(dev.headers.get("location") ?? "").origin).toBe(DEV);
  });

  it("refuses a confirmation another site sends, and one without a session or a body", async () => {
    const cookie = cookies[STRANGER] as string;
    for (const headers of [
      { cookie, "sec-fetch-site": "cross-site", origin: "https://evil.example.com" },
      { cookie, "sec-fetch-site": "same-site", origin: ORIGIN },
      { cookie, "sec-fetch-site": "same-origin", origin: "https://evil.example.com" },
      { cookie, "sec-fetch-site": "same-origin" },
    ]) {
      expect((await confirm(headers)).status, JSON.stringify(headers)).toBe(403);
    }
    const signedOut = await confirm({ "sec-fetch-site": "same-origin", origin: ORIGIN });
    const login = new URL((await signedOut.json<{ url: string }>()).url, ORIGIN);
    expect(login.pathname).toBe("/login");
    const malformed = await confirm(
      { cookie, "sec-fetch-site": "same-origin", origin: ORIGIN },
      {
        state: STATE,
        host: HOST,
        extra: true,
      },
    );
    expect((await malformed.json<{ url: string }>()).url).toBe(UNAVAILABLE_URL);
    expect(await db().select().from(schema.readHandoffs)).toEqual([]);
  });

  it("keeps the viewer's frame and review codes on `.dev`", async () => {
    const info = await (
      await get(on, `/api/v1/artifacts/${ID}/viewer`, cookies[STRANGER], {
        "sec-fetch-site": "same-origin",
      })
    ).json<{ origin: string }>();
    expect(info.origin).toBe(DEV);
    const page = await get(on, `/view/${ID}`, cookies[STRANGER]);
    expect(page.headers.get("content-security-policy")).toBe(await viewerCsp(env, ID));
  });
});
