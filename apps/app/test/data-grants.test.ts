// The app's side of artifact data grants (decision 0026, "The grant"): the consent control, the
// code a person's Allow issues, "Data you shared" and revocation. Session only, off by default.
import { env } from "cloudflare:workers";
import { PLANS } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import {
  claimVisitorId,
  dataNamespaces,
  declareDataCollection,
  pageDataCommand,
} from "@portifact/services";
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
    // The suite's configuration turns artifact data on; this test turns it off.
    const h = createHarness({ env: { ARTIFACT_DATA_ENABLED: "false" } });
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

    const status = async () =>
      (await h.request(`/api/v1/account/data-grants/${id}`, dashboard(cookie))).json();
    expect(await status()).toEqual({ artifactId: id, openGrants: 1 });
    const revoked = await h.request(
      `/api/v1/account/data-grants/${id}`,
      dashboard(cookie, "DELETE"),
    );
    expect(await revoked.json()).toEqual({ artifactId: id, revoked: 1 });
    expect(await status()).toEqual({ artifactId: id, openGrants: 0 });
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

  it("lists several artifacts in artifact order and answers 429 once codes run out", async () => {
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
    expect(listed.items.map((item) => item.artifactId)).toEqual([newer, older].sort());

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

  it("pages Data you shared by region and artifact, and refuses a cursor it never gave", async () => {
    const h = on();
    const reader = "grants-pages@example.test";
    const cookie = await h.signIn(reader);
    const db = regionsFromEnv(env).get("default").db;
    const [person] = await db.global
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, reader));
    const userId = person?.id ?? "";
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    for (let n = 0; n < 52; n++) {
      const id = `pg${alphabet[(n >> 5) & 31]}${alphabet[n & 31]}aaaaaa`;
      await db.insert(schema.artifacts).values({
        id,
        ownerId: userId,
        type: "site",
        name: `Board ${n}`,
        state: "active",
        accessMode: "restricted",
        currentVersionId: "v1",
        expiresAt: Date.now() + 86_400_000,
      });
      await db.insert(schema.dataGrants).values({
        id: `dg_${String(n).padStart(22, "0")}`,
        artifactId: id,
        userId,
        visitorId: "v_123456789012345678901234",
        authSessionId: "as_pages",
        host: `${id}.${env.CONTENT_DOMAIN}`,
        expiresAt: Date.now() + 86_400_000,
        redeemedAt: Date.now(),
      });
    }
    const seen: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page++) {
      const query: string = after === null ? "" : `?${new URLSearchParams({ after })}`;
      const response = await h.request(`/api/v1/account/data-grants${query}`, dashboard(cookie));
      expect(response.status).toBe(200);
      const body = await response.json<{ items: { artifactId: string }[]; next: string | null }>();
      seen.push(...body.items.map((item) => item.artifactId));
      after = body.next;
      if (after === null) break;
    }
    expect(seen).toHaveLength(52);
    expect(new Set(seen).size).toBe(52);
    const bad = await h.request("/api/v1/account/data-grants?after=nowhere:x", dashboard(cookie));
    expect(bad.status).toBe(400);
  });

  it("exports and deletes the person's own documents, as the journal names them, and nobody else's", async () => {
    const h = on();
    const ownerClient = await tokenClient(h, "rights-owner@example.test");
    const id = await publishSite(ownerClient, "Votes");
    const db = regionsFromEnv(env).get("default").db;
    const objects = dataNamespaces({ ...env, ARTIFACT_DATA_ENABLED: "true" }, "default");
    const declared = await declareDataCollection(
      db,
      { objects, bucket: env.ARTIFACTS, enabled: true },
      {
        userId: ownerClient.userId,
        artifactId: id,
        now: Date.now(),
        idempotencyKey: crypto.randomUUID(),
        declaration: { name: "votes", mode: "own" },
      },
    );
    expect(declared.ok).toBe(true);
    const visitor = await tokenClient(h, "rights-visitor@example.test");
    const claimed = await claimVisitorId(env.ARTIFACTS, visitor.userId, id, Date.now());
    if (!claimed.ok) throw new Error("claim failed");
    const created = await pageDataCommand(
      db,
      { objects, pageWrites: true },
      {
        artifactId: id,
        region: "default",
        limits: PLANS.free.data.perArtifact,
        caller: { kind: "visitor", author: claimed.value, canWrite: true },
        command: { kind: "create", collection: "votes", body: { choice: "a" } },
        idempotencyKey: null,
        now: Date.now(),
      },
    );
    if (!created.result.ok) throw new Error("create failed");
    const docId = (created.result.value.value as { _id: string })._id;

    const page = await h.request(
      `/api/v1/account/data-grants/${id}/mine`,
      dashboard(visitor.cookie),
    );
    expect(page.status).toBe(200);
    const body = await page.json<{ rows: { id: string }[]; next: string | null }>();
    expect(body.rows.map((row) => row.id)).toEqual([docId]);
    expect(body.next).toBeNull();

    // Someone else has nothing there, and cannot delete the visitor's document.
    const stranger = await h.signIn("rights-stranger@example.test");
    expect(
      (await h.request(`/api/v1/account/data-grants/${id}/mine`, dashboard(stranger))).status,
    ).toBe(404);
    const path = `/api/v1/account/data-grants/${id}/documents/votes/${docId}`;
    expect((await h.request(path, dashboard(stranger, "DELETE"))).status).toBe(404);
    const removed = await h.request(path, dashboard(visitor.cookie, "DELETE"));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deleted: true });
    // A request to the people who manage it: accepted for the visitor, like a missing artifact
    // for anyone the journal does not name.
    const ask = (cookie: string, kind: string) =>
      h.request(
        `/api/v1/account/data-grants/${id}/rights-request`,
        dashboard(cookie, "POST", { kind }),
      );
    const asked = await ask(visitor.cookie, "erasure");
    expect(asked.status).toBe(202);
    expect(await asked.json()).toEqual({ requested: true });
    expect((await ask(stranger, "erasure")).status).toBe(404);
    expect((await ask(visitor.cookie, "everything")).status).toBe(400);
    const jobs = await db
      .select({ subject: schema.outbox.subject })
      .from(schema.outbox)
      .where(eq(schema.outbox.topic, "data_rights_request"));
    expect(jobs).toContainEqual({ subject: id });
    expect(
      (
        await h.request(
          `/api/v1/account/data-grants/${id}/mine?after=nocolon`,
          dashboard(visitor.cookie),
        )
      ).status,
    ).toBe(400);
  });
});
