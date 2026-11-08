// The public report endpoint, the account export and account deletion from the dashboard.
import { env } from "cloudflare:workers";
import { REPORT_LIMITS } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishSite, tokenClient } from "./api-client.ts";
import { createHarness, ORIGIN, SESSION_COOKIE } from "./harness.ts";

const ARTIFACT_ORIGIN = "https://k7d2qm4xab.portifact.dev";

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

function report(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "cf-connecting-ip": "203.0.113.7",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

async function reportsFor(artifactId: string) {
  return (
    await env.DB.prepare("select * from abuse_reports where artifact_id = ?")
      .bind(artifactId)
      .all<{ reason: string; details: string | null; reporter_email: string | null }>()
  ).results;
}

async function errorCode(response: Response): Promise<string> {
  return (await response.json<{ error: { code: string } }>()).error.code;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_limits");
});

describe("public abuse reports", () => {
  it("stores a report given the artifact's address and answers 202 without credentials", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "report-owner@example.test");
    const id = await publishSite(owner);
    const response = await h.request(
      "/api/v1/reports",
      report({
        artifact: `https://${id}.portifact.dev/some/page.html`,
        reason: "phishing",
        details: "It asks for my bank password",
        email: "Reporter@Example.test",
      }),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ received: true });
    expect(await reportsFor(id)).toMatchObject([
      {
        reason: "phishing",
        details: "It asks for my bank password",
        reporter_email: "reporter@example.test",
      },
    ]);
  });

  it("answers an unknown artifact exactly like a real one and stores nothing", async () => {
    const h = createHarness();
    const response = await h.request(
      "/api/v1/reports",
      report({ artifact: "zzzzzzzzzz", reason: "spam" }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ received: true });
    expect(await reportsFor("zzzzzzzzzz")).toEqual([]);
  });

  it("refuses requests that do not come from the report page", async () => {
    const h = createHarness();
    const body = { artifact: "zzzzzzzzzz", reason: "spam" };
    for (const headers of [
      { origin: ARTIFACT_ORIGIN },
      { origin: "https://portifact.com" },
      { origin: "null" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
    ]) {
      const response = await h.request("/api/v1/reports", report(body, headers));
      expect(response.status, JSON.stringify(headers)).toBe(403);
    }
    const noMetadata = await h.request("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    });
    expect(noMetadata.status).toBe(403);
    // A cross-site form can only send form encodings, never JSON.
    const formPost = await h.request("/api/v1/reports", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
      },
      body: "artifact=zzzzzzzzzz&reason=spam",
    });
    expect(formPost.status).toBe(400);
  });

  it("validates the artifact, the reason, the details and the size", async () => {
    const h = createHarness();
    for (const body of [
      { artifact: "not an artifact", reason: "spam" },
      { artifact: "https://k7d2qm4xab.evil.example/", reason: "spam" },
      { artifact: "zzzzzzzzzz", reason: "boredom" },
      { artifact: "zzzzzzzzzz", reason: "spam", details: "x".repeat(REPORT_LIMITS.detailsMax + 1) },
      { artifact: "zzzzzzzzzz", reason: "spam", details: "bell\u0007" },
      { artifact: "zzzzzzzzzz", reason: "spam", email: "not-an-email" },
      { artifact: "zzzzzzzzzz", reason: "spam", artifactOwner: "u_1" },
    ]) {
      await env.DB.exec("DELETE FROM rate_limits");
      const response = await h.request("/api/v1/reports", report(body));
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(await errorCode(response)).toBe("invalid_input");
    }
    const huge = await h.request(
      "/api/v1/reports",
      report({ artifact: "zzzzzzzzzz", reason: "spam", details: "é".repeat(5000) }),
    );
    expect(huge.status).toBe(400);
  });

  it("limits reports per IP and lets other addresses through", async () => {
    const h = createHarness();
    const body = { artifact: "zzzzzzzzzz", reason: "spam" };
    for (let i = 0; i < REPORT_LIMITS.perIp.max; i += 1) {
      expect((await h.request("/api/v1/reports", report(body))).status).toBe(202);
    }
    const limited = await h.request("/api/v1/reports", report(body));
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const other = await h.request(
      "/api/v1/reports",
      report(body, { "cf-connecting-ip": "198.51.100.9" }),
    );
    expect(other.status).toBe(202);
  });

  it("limits reports per artifact across addresses", async () => {
    const h = createHarness();
    const body = { artifact: "yyyyyyyyyy", reason: "spam" };
    for (let i = 0; i < REPORT_LIMITS.perArtifact.max; i += 1) {
      const response = await h.request(
        "/api/v1/reports",
        report(body, { "cf-connecting-ip": `192.0.2.${i}` }),
      );
      expect(response.status).toBe(202);
    }
    const limited = await h.request(
      "/api/v1/reports",
      report(body, { "cf-connecting-ip": "192.0.2.250" }),
    );
    expect(limited.status).toBe(429);
  });

  it("serves the report page on the app host only, with the strict page headers", async () => {
    const h = createHarness();
    const page = await h.request("/report?artifact=k7d2qm4xab");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("Report an artifact");
    const onSite = await h.request("https://portifact.com/report");
    expect(onSite.status).toBe(404);
  });
});

describe("account export", () => {
  it("downloads the account's data as JSON for the session's own user only", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "export-owner@example.test");
    const other = await tokenClient(h, "export-other@example.test");
    const mine = await publishSite(owner, "Mine");
    const theirs = await publishSite(other, "Theirs");
    const response = await h.request("/api/v1/account/export", dashboard(owner.cookie));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="portifact-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const data = await response.json<{
      account: { email: string };
      artifacts: { id: string; versions: { download: string }[] }[];
    }>();
    expect(data.account.email).toBe("export-owner@example.test");
    expect(data.artifacts.map((a) => a.id)).toEqual([mine]);
    expect(JSON.stringify(data)).not.toContain(theirs);
    // The download path in the export works for the owner through the existing route.
    const download = await owner.call(data.artifacts[0]?.versions[0]?.download ?? "");
    expect(download.status).toBe(200);
  });
});

describe("account deletion", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes the account, signs the browser out and revokes every token", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "delete-owner@example.test");
    const id = await publishSite(owner);
    const response = await h.request(
      "/api/v1/account/delete",
      dashboard(owner.cookie, "POST", { confirmEmail: "delete-owner@example.test" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=; Max-Age=0`);

    // The session, the CLI token and the artifact are gone at once.
    expect((await h.request("/api/v1/account/sessions", dashboard(owner.cookie))).status).toBe(401);
    expect((await owner.call("/api/v1/me")).status).toBe(401);
    expect((await owner.call(`/api/v1/artifacts/${id}`)).status).toBe(401);
    const row = await env.DB.prepare("select state from artifacts where id = ?")
      .bind(id)
      .first<{ state: string }>();
    expect(row?.state).toBe("purging");

    // The same address can sign up again as a new, empty account.
    const again = await tokenClient(h, "delete-owner@example.test");
    expect(again.userId).not.toBe(owner.userId);
    const list = await again.call("/api/v1/artifacts");
    expect((await list.json<{ items: unknown[] }>()).items).toEqual([]);
  });

  it("needs the email typed again", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "delete-confirm@example.test");
    for (const body of [{ confirmEmail: "someone@example.test" }, {}, { confirmEmail: 5 }]) {
      const response = await h.request(
        "/api/v1/account/delete",
        dashboard(owner.cookie, "POST", body),
      );
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("invalid_input");
    }
    expect((await owner.call("/api/v1/me")).status).toBe(200);
  });

  it("needs a session signed in within the last minutes", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "delete-stale@example.test");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const response = await h.request(
      "/api/v1/account/delete",
      dashboard(owner.cookie, "POST", { confirmEmail: "delete-stale@example.test" }),
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("reauthentication_required");
    expect((await owner.call("/api/v1/me")).status).toBe(200);
  });
});
