// The brand of the account's space on the viewer's bar (premium plan P9) through the app: the
// session-only account routes, the same `plan_required` body as every gated operation, the logo
// read back for the preview, and the brand the viewer lookup returns. Brand management is not
// exposed to bearer tokens, MCP or the CLI, so its gate is tested here rather than in the GATED
// table of plan-gates.test.ts, which covers operations served by both the API and MCP.
import { env } from "cloudflare:workers";
import { BRAND_LIMITS, BrandSettings, planRequiredMessage, ViewerInfo } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { png } from "@portifact/domain/testing/images";
import { beforeEach, describe, expect, it } from "vitest";
import { publishSite, type TokenClient, tokenClient } from "./api-client.ts";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";

const db = () => regionsFromEnv(env).get("default").db;
const BRAND = { name: "Acme", accentColor: "#1a2b3c", link: "https://acme.example.com" };

let h: Harness;
let owner: TokenClient;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_limits");
  h = createHarness();
  owner = await tokenClient(h, `brand-${crypto.randomUUID()}@example.test`);
});

/** A dashboard request: the session cookie, same-origin metadata and, on writes, the Origin. */
function dashboard(
  path: string,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  const raw = body instanceof Uint8Array;
  return h.request(path, {
    method,
    headers: {
      cookie: owner.cookie,
      "sec-fetch-site": "same-origin",
      ...(method === "GET" ? {} : { origin: ORIGIN }),
      ...(body === undefined
        ? {}
        : { "content-type": raw ? "application/octet-stream" : "application/json" }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
  });
}

async function onPlan(ownerId: string, plan: "free" | "pro") {
  await db()
    .insert(schema.ownerPlans)
    .values({ ownerId, plan, seats: 1, grantedBy: "test", updatedAt: Date.now() })
    .onConflictDoUpdate({ target: schema.ownerPlans.ownerId, set: { plan } });
}

describe("the brand routes", () => {
  it("refuse bearer tokens, missing sessions and other origins", async () => {
    for (const [method, path] of [
      ["GET", "/api/v1/account/branding"],
      ["PUT", "/api/v1/account/branding"],
      ["DELETE", "/api/v1/account/branding"],
      ["GET", "/api/v1/account/branding/logo"],
      ["PUT", "/api/v1/account/branding/logo"],
      ["DELETE", "/api/v1/account/branding/logo"],
    ] as const) {
      const bearer = await owner.call(path, { method });
      expect(bearer.status, `${method} ${path} bearer`).toBe(403);
      const anonymous = await h.request(path, {
        method,
        headers: { "sec-fetch-site": "same-origin", origin: ORIGIN },
      });
      expect(anonymous.status, `${method} ${path} anonymous`).toBe(401);
      const sibling = await dashboard(path, method, undefined, {
        "sec-fetch-site": "cross-site",
        origin: "https://abcdefghij.portifact.dev",
      });
      expect(sibling.status, `${method} ${path} cross-site`).toBe(403);
    }
  });

  it("refuse a free owner with the same plan_required body as every gated operation", async () => {
    const body = { error: { code: "plan_required", message: planRequiredMessage("branding") } };
    const brand = await dashboard("/api/v1/account/branding", "PUT", BRAND);
    expect(brand.status).toBe(403);
    expect(await brand.json()).toEqual(body);
    const logo = await dashboard("/api/v1/account/branding/logo", "PUT", png());
    expect(logo.status).toBe(403);
    expect(await logo.json()).toEqual(body);
    const read = await dashboard("/api/v1/account/branding");
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(BrandSettings.parse(await read.json())).toEqual({
      available: false,
      lowestPlan: "pro",
      suspended: false,
      reason: null,
      statement: null,
      brand: null,
    });
  });

  it("let a Pro owner set the brand and a logo, read back as an image that cannot run", async () => {
    await onPlan(owner.userId, "pro");
    const saved = await dashboard("/api/v1/account/branding", "PUT", BRAND);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      available: true,
      brand: { name: "Acme", link: "https://acme.example.com/", accentColor: "#1a2b3c" },
    });
    // The link may not point at the app or at artifact origins.
    const own = await dashboard("/api/v1/account/branding", "PUT", {
      ...BRAND,
      link: `${ORIGIN}/login`,
    });
    expect(own.status).toBe(400);
    expect(await own.json()).toMatchObject({ error: { code: "invalid_input" } });

    const bytes = png();
    const uploaded = await dashboard("/api/v1/account/branding/logo", "PUT", bytes, {
      // The declared type is ignored: the bytes decide.
      "content-type": "image/svg+xml",
    });
    expect(uploaded.status).toBe(200);
    const settings = BrandSettings.parse(await uploaded.json());
    expect(settings.brand?.logo).toMatchObject({ type: "image/png", bytes: bytes.length });

    const read = await dashboard("/api/v1/account/branding/logo");
    expect(read.status).toBe(200);
    expect(Object.fromEntries(read.headers)).toMatchObject({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "no-store",
    });
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);

    const removed = await dashboard("/api/v1/account/branding/logo", "DELETE");
    expect(await removed.json()).toMatchObject({ brand: { logo: null } });
    expect((await dashboard("/api/v1/account/branding/logo")).status).toBe(404);
    const deleted = await dashboard("/api/v1/account/branding", "DELETE");
    expect(await deleted.json()).toMatchObject({ brand: null });
  });

  it("refuse a logo over the size cap without reading past it, and bytes that are not an image", async () => {
    await onPlan(owner.userId, "pro");
    await dashboard("/api/v1/account/branding", "PUT", BRAND);
    const big = new Uint8Array(BRAND_LIMITS.logoMaxBytes + 1);
    const tooBig = await dashboard("/api/v1/account/branding/logo", "PUT", big);
    expect(tooBig.status).toBe(400);
    expect(await tooBig.json()).toEqual({
      error: { code: "invalid_input", message: "logo: Use an image of at most 100 KB." },
    });
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const refused = await dashboard("/api/v1/account/branding/logo", "PUT", svg, {
      "content-type": "image/png",
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: "invalid_input" } });
    const malformed = await dashboard("/api/v1/account/branding", "PUT", { ...BRAND, html: "<b>" });
    expect(malformed.status).toBe(400);
  });
});

describe("the viewer lookup", () => {
  const view = (artifactId: string, cookie = "") =>
    h.request(`/api/v1/artifacts/${artifactId}/viewer`, {
      headers: { ...(cookie ? { cookie } : {}), "sec-fetch-site": "same-origin" },
    });

  it("returns the brand of a Pro owner with the logo on the artifact's own origin", async () => {
    const artifactId = await publishSite(owner, "Branded");
    await onPlan(owner.userId, "pro");
    await dashboard("/api/v1/account/branding", "PUT", BRAND);
    const uploaded = BrandSettings.parse(
      await (await dashboard("/api/v1/account/branding/logo", "PUT", png())).json(),
    );
    const sha = uploaded.brand?.logo?.sha256;
    const info = ViewerInfo.parse(await (await view(artifactId, owner.cookie)).json());
    expect(info.brand).toEqual({
      name: "Acme",
      accentColor: "#1a2b3c",
      link: "https://acme.example.com/",
      logo: {
        url: `https://${artifactId}.portifact.dev/__portifact/brand/${sha}`,
        width: 64,
        height: 32,
      },
    });
    // A visitor who cannot open the artifact learns nothing about the brand.
    const stranger = await h.signIn(`brand-stranger-${crypto.randomUUID()}@example.test`);
    const hidden = await view(artifactId, stranger);
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(await hidden.json())).not.toContain("Acme");

    // The default bar once the plan lapses; the brand is kept.
    await onPlan(owner.userId, "free");
    expect(ViewerInfo.parse(await (await view(artifactId, owner.cookie)).json()).brand).toBeNull();
    expect(
      BrandSettings.parse(await (await dashboard("/api/v1/account/branding")).json()).brand?.name,
    ).toBe("Acme");
  });
});
