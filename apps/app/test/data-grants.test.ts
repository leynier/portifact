// The app's side of artifact data grants (decision 0026, "The grant"): the consent control, the
// code a person's Allow issues, "Data you shared" and revocation. Session only, off by default.
import { env } from "cloudflare:workers";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { publishSite, tokenClient } from "./api-client.ts";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";

const NONCE_HASH = "h".repeat(43);

function dashboard(cookie: string, method = "GET", body?: unknown): RequestInit {
  return {
    method,
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

const on = () => createHarness({ env: { ARTIFACT_DATA_ENABLED: "true" } });

/** An artifact with data whose owner lists `readerEmail` as a reader. */
async function artifactWithData(h: Harness, owner: string, readerEmail: string) {
  const c = await tokenClient(h, owner);
  const id = await publishSite(c, "Board");
  const db = regionsFromEnv(env).get("default").db;
  await db.insert(schema.artifactReaders).values({ artifactId: id, email: readerEmail });
  await db.insert(schema.artifactData).values({ artifactId: id, updatedAt: Date.now() });
  return id;
}

describe("data grants on the app", () => {
  it("answers 404 while artifact data is off", async () => {
    const h = createHarness();
    const cookie = await h.signIn("grants-off@example.test");
    for (const [path, method] of [
      ["/api/v1/account/data-grants", "GET"],
      ["/api/v1/account/data-grants/k7d2qm4xab/control", "GET"],
      ["/api/v1/account/data-grants/k7d2qm4xab", "DELETE"],
    ] as const) {
      expect((await h.request(path, dashboard(cookie, method))).status).toBe(404);
    }
    const issued = await h.request(
      "/api/v1/account/data-grants",
      dashboard(cookie, "POST", { artifactId: "k7d2qm4xab", nonceHash: NONCE_HASH, flow: "top" }),
    );
    expect(issued.status).toBe(404);
  });

  it("draws the control, issues a code to the reader and lists then revokes the grant", async () => {
    const h = on();
    const id = await artifactWithData(h, "grants-owner@example.test", "grants-reader@example.test");
    const cookie = await h.signIn("grants-reader@example.test");

    const control = await h.request(`/api/v1/account/data-grants/${id}/control`, dashboard(cookie));
    expect(control.status).toBe(200);
    expect(await control.json()).toMatchObject({
      artifactId: id,
      artifactName: "Board",
      host: `${id}.${env.CONTENT_DOMAIN}`,
      owner: { kind: "user" },
      grantDays: 30,
    });

    const issued = await h.request(
      "/api/v1/account/data-grants",
      dashboard(cookie, "POST", { artifactId: id, nonceHash: NONCE_HASH, flow: "frame" }),
    );
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const { code, redeemUrl } = await issued.json<{ code: string; redeemUrl: string }>();
    const url = new URL(redeemUrl);
    expect(url.origin).toBe(`https://${id}.${env.CONTENT_DOMAIN}`);
    expect(url.pathname).toBe("/__portifact/data/grant");
    expect(url.searchParams.get("flow")).toBe("frame");
    expect(url.searchParams.get("code")).toBe(code);

    // A grant counts once its code redeemed; mark it as the content Worker would.
    const db = regionsFromEnv(env).get("default").db;
    await db
      .update(schema.dataGrants)
      .set({ redeemedAt: Date.now() })
      .where(eq(schema.dataGrants.artifactId, id));
    const listed = await (await h.request("/api/v1/account/data-grants", dashboard(cookie))).json<{
      items: { artifactId: string; openGrants: number }[];
    }>();
    expect(listed.items).toEqual([expect.objectContaining({ artifactId: id, openGrants: 1 })]);

    const revoked = await h.request(
      `/api/v1/account/data-grants/${id}`,
      dashboard(cookie, "DELETE"),
    );
    expect(await revoked.json()).toEqual({ artifactId: id, revoked: 1 });
  });

  it("answers a stranger like a missing artifact and never names the reader's email", async () => {
    const h = on();
    const id = await artifactWithData(
      h,
      "grants-owner2@example.test",
      "grants-reader2@example.test",
    );
    const stranger = await h.signIn("grants-stranger@example.test");
    const control = await h.request(
      `/api/v1/account/data-grants/${id}/control`,
      dashboard(stranger),
    );
    expect(control.status).toBe(404);
    const issued = await h.request(
      "/api/v1/account/data-grants",
      dashboard(stranger, "POST", { artifactId: id, nonceHash: NONCE_HASH, flow: "top" }),
    );
    expect(issued.status).toBe(404);

    const reader = await h.signIn("grants-reader2@example.test");
    const body = await (
      await h.request(`/api/v1/account/data-grants/${id}/control`, dashboard(reader))
    ).text();
    expect(body).not.toContain("grants-reader2@example.test");
  });

  it("refuses bearer tokens, other origins and a foreign host", async () => {
    const h = on();
    const id = await artifactWithData(
      h,
      "grants-owner3@example.test",
      "grants-reader3@example.test",
    );
    const c = await tokenClient(h, "grants-reader3@example.test");
    const bearer = await c.call("/api/v1/account/data-grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifactId: id, nonceHash: NONCE_HASH, flow: "top" }),
    });
    expect(bearer.status).toBe(403);

    const crossOrigin = await h.request("/api/v1/account/data-grants", {
      method: "POST",
      headers: {
        cookie: c.cookie,
        "sec-fetch-site": "same-site",
        origin: `https://${id}.${env.CONTENT_DOMAIN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ artifactId: id, nonceHash: NONCE_HASH, flow: "top" }),
    });
    expect(crossOrigin.status).toBe(403);

    const foreign = await h.request(
      "/api/v1/account/data-grants",
      dashboard(c.cookie, "POST", {
        artifactId: id,
        nonceHash: NONCE_HASH,
        flow: "top",
        host: "evil.example",
      }),
    );
    expect(foreign.status).toBe(404);
    const db = regionsFromEnv(env).get("default").db;
    expect(
      await db.select().from(schema.dataGrants).where(eq(schema.dataGrants.artifactId, id)),
    ).toEqual([]);
  });

  it("refuses a new grant without the current terms, but lists and revokes", async () => {
    const h = on();
    const id = await artifactWithData(
      h,
      "grants-owner4@example.test",
      "grants-reader4@example.test",
    );
    const cookie = await h.signIn("grants-reader4@example.test");
    const db = regionsFromEnv(env).get("default").db;
    await db
      .update(schema.users)
      .set({ termsVersion: "2020-01-01" })
      .where(eq(schema.users.email, "grants-reader4@example.test"));
    const issued = await h.request(
      "/api/v1/account/data-grants",
      dashboard(cookie, "POST", { artifactId: id, nonceHash: NONCE_HASH, flow: "top" }),
    );
    expect(issued.status).toBe(403);
    expect(await issued.json()).toMatchObject({ error: { code: "terms_not_accepted" } });
    expect((await h.request("/api/v1/account/data-grants", dashboard(cookie))).status).toBe(200);
    expect(
      (await h.request(`/api/v1/account/data-grants/${id}`, dashboard(cookie, "DELETE"))).status,
    ).toBe(200);
  });

  it("treats the artifact's own .dev host as no custom host, and refuses malformed IDs", async () => {
    const h = on();
    const id = await artifactWithData(
      h,
      "grants-owner5@example.test",
      "grants-reader5@example.test",
    );
    const cookie = await h.signIn("grants-reader5@example.test");
    const dev = `${id}.${env.CONTENT_DOMAIN}`;
    const control = await h.request(
      `/api/v1/account/data-grants/${id}/control?host=${dev}`,
      dashboard(cookie),
    );
    expect(control.status).toBe(200);
    const foreignControl = await h.request(
      `/api/v1/account/data-grants/${id}/control?host=evil.example`,
      dashboard(cookie),
    );
    expect(foreignControl.status).toBe(404);
    const issued = await h.request(
      "/api/v1/account/data-grants",
      dashboard(cookie, "POST", { artifactId: id, nonceHash: NONCE_HASH, flow: "top", host: dev }),
    );
    expect(new URL((await issued.json<{ redeemUrl: string }>()).redeemUrl).host).toBe(dev);
    for (const [path, method] of [
      ["/api/v1/account/data-grants/NOT-AN-ID/control", "GET"],
      ["/api/v1/account/data-grants/NOT-AN-ID", "DELETE"],
    ] as const) {
      expect((await h.request(path, dashboard(cookie, method))).status).toBe(404);
    }
    const bad = await h.request(
      "/api/v1/account/data-grants",
      dashboard(cookie, "POST", { artifactId: id, nonceHash: "short", flow: "top" }),
    );
    expect(bad.status).toBe(400);
  });

  it("lists several artifacts newest first and answers 429 once codes run out", async () => {
    await env.DB.exec("DELETE FROM rate_limits");
    const h = on();
    const reader = "grants-reader6@example.test";
    const older = await artifactWithData(h, "grants-owner6@example.test", reader);
    const newer = await artifactWithData(h, "grants-owner7@example.test", reader);
    const cookie = await h.signIn(reader);
    const db = regionsFromEnv(env).get("default").db;
    for (const [id, at] of [
      [older, Date.now() - 60_000],
      [newer, Date.now()],
    ] as const) {
      const issued = await h.request(
        "/api/v1/account/data-grants",
        dashboard(cookie, "POST", { artifactId: id, nonceHash: NONCE_HASH, flow: "top" }),
      );
      expect(issued.status).toBe(200);
      await db
        .update(schema.dataGrants)
        .set({ redeemedAt: at, createdAt: at })
        .where(eq(schema.dataGrants.artifactId, id));
    }
    const listed = await (await h.request("/api/v1/account/data-grants", dashboard(cookie))).json<{
      items: { artifactId: string }[];
    }>();
    expect(listed.items.map((item) => item.artifactId)).toEqual([newer, older]);

    let last = 0;
    for (let i = 0; i < 10; i++) {
      last = (
        await h.request(
          "/api/v1/account/data-grants",
          dashboard(cookie, "POST", { artifactId: newer, nonceHash: NONCE_HASH, flow: "top" }),
        )
      ).status;
    }
    expect(last).toBe(429);
  });
});
