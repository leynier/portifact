// Cookies sibling artifacts inject on the shared domain (portifact.dev is not on the Public
// Suffix List): they never grant anything and are expired once they grow. Access with injected
// cookies next to real sessions is covered in read-session.test.ts and review.test.ts.
import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { beforeEach, describe, expect, it } from "vitest";
import { READ_COOKIE } from "../src/cookies.ts";
import { handle } from "../src/index.ts";
import {
  CLEANUP_BUDGET,
  cookiePaths,
  FOREIGN_COOKIE_LIMIT,
  injectedCookieCleanup,
  isPortifactCookie,
  MAX_CLEANUP_PATHS,
} from "../src/injected.ts";
import { REVIEW_COOKIE, REVIEW_TAB_COOKIE } from "../src/review.ts";
import { NO_BAR_COOKIE } from "../src/viewer.ts";

const ID = "c7d2qm4xab";
const ORIGIN = `https://${ID}.portifact.dev`;
const DOMAIN = "portifact.dev";
const NOW = Date.UTC(2026, 10, 8, 12);
const PAGE = "<h1>Neighbour</h1>";
const DOCS = "<h1>Docs</h1>";
const NAVIGATE = {
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};
// A frame review cookie on a top-level navigation is cleared as planted (review.test.ts), so
// requests carrying every Portifact cookie are the page's own subresource loads.
const SAME_ORIGIN = {
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Dest": "script",
};

async function seed() {
  const db = regionsFromEnv(env).get("default").db;
  for (const table of ["version_files", "versions", "objects", "artifacts"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  await db.insert(schema.artifacts).values({
    id: ID,
    ownerId: "u_owner",
    type: "site",
    name: "Neighbour",
    state: "active",
    accessMode: "public",
    // Top-level visits here test the artifact itself; the viewer redirect has its own tests.
    bar: false,
    currentVersionId: "v1",
  });
  await db.insert(schema.versions).values({
    id: "v1",
    artifactId: ID,
    number: 1,
    authorId: "u_owner",
    entrypoint: "index.html",
    publishedBytes: PAGE.length + DOCS.length,
  });
  for (const [path, body, hash] of [
    ["index.html", PAGE, "a".repeat(64)],
    ["docs/index.html", DOCS, "b".repeat(64)],
  ] as const) {
    const key = `objects/u_owner/${hash}`;
    await env.ARTIFACTS.put(key, body);
    await db.insert(schema.objects).values({
      ownerId: "u_owner",
      sha256: hash,
      size: body.length,
      r2Key: key,
      state: "verified",
    });
    await db.insert(schema.versionFiles).values({
      versionId: "v1",
      kind: "published",
      path,
      ownerId: "u_owner",
      sha256: hash,
      size: body.length,
      contentType: "text/html; charset=utf-8",
    });
  }
}

/**
 * A browser's cookies for the artifact origin, keyed by name, domain and path like a real jar:
 * the Cookie header lists every cookie whose path matches, longest path first.
 */
class Jar {
  readonly cookies = new Map<
    string,
    { name: string; value: string; path: string; domain: string }
  >();
  add(name: string, value: string, { path = "/", domain = DOMAIN } = {}) {
    this.cookies.set(`${name};${domain};${path}`, { name, value, path, domain });
  }
  header(pathname: string): string {
    return [...this.cookies.values()]
      .filter(({ path }) => matches(path, pathname))
      .sort((a, b) => b.path.length - a.path.length)
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");
  }
  apply(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const attributes = new Map(
        cookie
          .split(";")
          .slice(1)
          .map((part) => part.trim().split("=") as [string, string?])
          .map(([key, value]) => [key.toLowerCase(), value ?? ""]),
      );
      const name = cookie.slice(0, cookie.indexOf("="));
      // Partitioned deletions address a partition these cookies are not in.
      if (attributes.has("partitioned") || attributes.get("max-age") !== "0") continue;
      const domain = attributes.get("domain") ?? "host";
      this.cookies.delete(`${name};${domain};${attributes.get("path") ?? "/"}`);
    }
  }
  get size() {
    return this.cookies.size;
  }
}

function matches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function get(path: string, cookie: string, fetchMetadata: Record<string, string> = NAVIGATE) {
  const headers = new Headers(fetchMetadata);
  if (cookie) headers.set("Cookie", cookie);
  return handle(new Request(`${ORIGIN}${path}`, { headers }), env, NOW);
}

/** `count` injected cookies of about `size` bytes each, as one hostile artifact sets them. */
function inject(jar: Jar, count: number, size = 60, options: { path?: string } = {}) {
  for (let index = 0; index < count; index++) {
    jar.add(`inj${index}`, "x".repeat(size), options);
  }
}

describe("injected cookies on delivery", () => {
  beforeEach(() => seed());

  it("serves the page and expires hundreds of injected cookies until none are left", async () => {
    const jar = new Jar();
    inject(jar, 300);
    expect(jar.header("/").length).toBeGreaterThan(FOREIGN_COOKIE_LIMIT);
    let requests = 0;
    while (jar.header("/").length > FOREIGN_COOKIE_LIMIT && requests < 20) {
      const response = await get("/", jar.header("/"));
      requests += 1;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(PAGE);
      const cleared = response.headers.getSetCookie();
      expect(cleared.length).toBeGreaterThan(0);
      const spent = cleared.reduce((sum, cookie) => sum + cookie.length, 0);
      expect(spent).toBeLessThanOrEqual(CLEANUP_BUDGET);
      for (const cookie of cleared) {
        expect(cookie).toMatch(
          /^inj\d+=; Max-Age=0; Domain=portifact\.dev; Path=\/; Secure; SameSite=None(; Partitioned)?$/,
        );
      }
      jar.apply(response);
    }
    // A few requests, as a page's own subresources make, bring the header back under the limit.
    expect(requests).toBeLessThanOrEqual(5);
    // Under the limit nothing more is cleared: small cookies on the shared domain keep working.
    const after = await get("/", jar.header("/"));
    expect(after.status).toBe(200);
    expect(after.headers.getSetCookie()).toEqual([]);
  });

  it("expires path-scoped injected cookies at the paths the request matched", async () => {
    const jar = new Jar();
    inject(jar, 100, 60, { path: "/docs" });
    inject(jar, 100, 60, { path: "/docs/" });
    expect(jar.header("/").length).toBe(0);
    const response = await get("/docs/", jar.header("/docs/"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(DOCS);
    const paths = new Set(
      response.headers.getSetCookie().map((cookie) => /Path=([^;]*)/.exec(cookie)?.[1]),
    );
    expect(paths).toEqual(new Set(["/", "/docs", "/docs/"]));
    jar.apply(response);
    for (let requests = 0; requests < 5; requests++) {
      jar.apply(await get("/docs/", jar.header("/docs/")));
    }
    expect(jar.header("/docs/").length).toBeLessThanOrEqual(FOREIGN_COOKIE_LIMIT);
    // Each cleared name went at both of its paths, not only at the first one tried.
    const left = new Set([...jar.cookies.values()].map(({ name }) => name));
    expect(jar.size).toBe(left.size * 2);
  });

  it("never clears or counts Portifact's own cookies, and clears names that imitate them", async () => {
    const own = [
      `${READ_COOKIE}=${"r".repeat(2_000)}`,
      `__Host-pf_read_tx_abcdefghijklmnop=${"t".repeat(2_000)}`,
      `__Host-pf_read_tx_qrstuvwxyzABCDEF=${"t".repeat(2_000)}`,
      `${REVIEW_COOKIE}=${"v".repeat(2_000)}`,
      `${REVIEW_TAB_COOKIE}=${"w".repeat(2_000)}`,
    ].join("; ");
    const quiet = await get("/", `${own}; theme=dark; _ga=GA1.1.123`, SAME_ORIGIN);
    expect(quiet.status).toBe(200);
    expect(quiet.headers.getSetCookie()).toEqual([]);

    const imitations = `__host-pf_read=x; pf_read=x; __Secure-pf_review=x; PF_REVIEW_TAB=x`;
    const response = await get("/", `${own}; theme=dark; ${imitations}`, SAME_ORIGIN);
    expect(response.status).toBe(200);
    const names = response.headers
      .getSetCookie()
      .map((cookie) => cookie.slice(0, cookie.indexOf("=")));
    expect(new Set(names)).toEqual(
      new Set(["__host-pf_read", "pf_read", "__Secure-pf_review", "PF_REVIEW_TAB"]),
    );
  });

  it("clears on every kind of answer, including refusals", async () => {
    const jar = new Jar();
    inject(jar, 300);
    const missing = await get("/missing.css", jar.header("/missing.css"));
    expect(missing.status).toBe(404);
    expect(missing.headers.getSetCookie().length).toBeGreaterThan(0);
    const post = await handle(
      new Request(`${ORIGIN}/`, { method: "POST", headers: { Cookie: jar.header("/") } }),
      env,
      NOW,
    );
    expect(post.status).toBe(405);
    expect(post.headers.getSetCookie().length).toBeGreaterThan(0);
  });
});

describe("injected cookie cleanup", () => {
  it("lists the cookie paths a request matches", () => {
    expect(cookiePaths("/")).toEqual(["/"]);
    expect(cookiePaths("/a")).toEqual(["/", "/a"]);
    expect(cookiePaths("/a/b")).toEqual(["/", "/a", "/a/", "/a/b"]);
    expect(cookiePaths("/a/b/")).toEqual(["/", "/a", "/a/", "/a/b", "/a/b/"]);
    expect(cookiePaths(`/${"x/".repeat(50)}`)).toHaveLength(MAX_CLEANUP_PATHS);
  });

  it("knows Portifact's cookies by exact name only", () => {
    expect(isPortifactCookie(READ_COOKIE)).toBe(true);
    expect(isPortifactCookie(REVIEW_COOKIE)).toBe(true);
    expect(isPortifactCookie(REVIEW_TAB_COOKIE)).toBe(true);
    expect(isPortifactCookie(NO_BAR_COOKIE)).toBe(true);
    expect(isPortifactCookie("__Host-pf_read_tx_abcdefghijklmnop")).toBe(true);
    for (const name of [
      "__host-pf_read",
      "__Host-pf_Read",
      "pf_read",
      "__Host-pf_review_x",
      "__host-pf_nobar",
      "",
    ]) {
      expect(isPortifactCookie(name)).toBe(false);
    }
  });

  it("does nothing without cookies or under the limit", () => {
    expect(injectedCookieCleanup(null, "/", DOMAIN)).toEqual([]);
    expect(injectedCookieCleanup("", "/", DOMAIN)).toEqual([]);
    const small = `a=${"x".repeat(FOREIGN_COOKIE_LIMIT - 10)}`;
    expect(injectedCookieCleanup(small, "/", DOMAIN)).toEqual([]);
  });

  it("counts nameless cookies toward the limit but only writes back names it can", () => {
    const header = [
      "x".repeat(FOREIGN_COOKIE_LIMIT),
      `badé=1`,
      `=${"y".repeat(10)}`,
      "good=1",
    ].join("; ");
    const cleared = injectedCookieCleanup(header, "/", DOMAIN);
    expect(cleared).toEqual([
      "good=; Max-Age=0; Domain=portifact.dev; Path=/; Secure; SameSite=None",
      "good=; Max-Age=0; Domain=portifact.dev; Path=/; Secure; SameSite=None; Partitioned",
    ]);
  });

  it("clears imitations of ours first, then the largest cookies, each at every path", () => {
    const header = [
      `small=${"s".repeat(10)}`,
      `large=${"l".repeat(FOREIGN_COOKIE_LIMIT)}`,
      "pf_read=x",
    ].join("; ");
    const cleared = injectedCookieCleanup(header, "/a", DOMAIN).map(
      (cookie) => `${cookie.slice(0, cookie.indexOf("="))} ${/Path=([^;]*)/.exec(cookie)?.[1]}`,
    );
    expect(cleared).toEqual([
      "pf_read /",
      "pf_read /",
      "pf_read /a",
      "pf_read /a",
      "large /",
      "large /",
      "large /a",
      "large /a",
      "small /",
      "small /",
      "small /a",
      "small /a",
    ]);
  });

  it("always clears the largest name whole, even one that alone passes the budget", () => {
    const name = "n".repeat(CLEANUP_BUDGET);
    const cleared = injectedCookieCleanup(`${name}=1; other=${"o".repeat(10)}`, "/", DOMAIN);
    expect(cleared).toHaveLength(2);
    for (const cookie of cleared) expect(cookie.startsWith(`${name}=; Max-Age=0`)).toBe(true);
  });
});
