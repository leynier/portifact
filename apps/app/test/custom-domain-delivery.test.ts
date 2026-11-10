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

async function seed(accessMode: "public" | "restricted", withDomain: boolean) {
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
  on = createHarness({ domains: new FakeDomains() });
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
