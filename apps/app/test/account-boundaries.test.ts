// Refusals at the edges of the account endpoints: a workspace the person is not in answers every
// branding route like a missing one, a logo is judged by its declared and read size before
// anything else, and a comment notice mute refuses a malformed ID or an artifact the person cannot
// read like a missing artifact.
import { describe, expect, it } from "vitest";
import { publishSite, tokenClient } from "./api-client.ts";
import { createHarness, ORIGIN } from "./harness.ts";

function dashboard(cookie: string, method = "GET", body?: BodyInit, headers = {}): RequestInit {
  return {
    method,
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      ...(method === "GET" ? {} : { origin: ORIGIN }),
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  };
}

describe("account endpoint boundaries", () => {
  it("answers every branding route for a workspace the person is not in like a missing one", async () => {
    const h = createHarness();
    const cookie = await h.signIn("boundaries-brand@example.test");
    const json = { "content-type": "application/json" };
    const requests: [string, string, BodyInit | undefined, Record<string, string>][] = [
      [
        "/api/v1/account/branding",
        "PUT",
        JSON.stringify({ name: "Acme", accentColor: null, link: null }),
        json,
      ],
      ["/api/v1/account/branding", "DELETE", undefined, {}],
      ["/api/v1/account/branding/logo", "PUT", new Uint8Array([1, 2, 3]), {}],
      ["/api/v1/account/branding/logo", "DELETE", undefined, {}],
      ["/api/v1/account/branding/logo", "GET", undefined, {}],
    ];
    for (const [path, method, body, headers] of requests) {
      const response = await h.request(
        `${path}?workspace=not-mine`,
        dashboard(cookie, method, body, headers),
      );
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("refuses a logo whose declared size is over the limit before reading it", async () => {
    const h = createHarness();
    const cookie = await h.signIn("boundaries-logo@example.test");
    const response = await h.request(
      "/api/v1/account/branding/logo",
      dashboard(cookie, "PUT", new Uint8Array(10), { "content-length": "100001" }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_input", message: "logo: Use an image of at most 100 KB." },
    });
  });

  it("judges an empty logo upload by its bytes and refuses it", async () => {
    const h = createHarness();
    const cookie = await h.signIn("boundaries-empty@example.test");
    const response = await h.request(
      "/api/v1/account/branding/logo",
      dashboard(cookie, "PUT", undefined, { "content-length": "0" }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it("refuses a comment notice mute for a malformed ID or an artifact the person cannot read", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "boundaries-owner@example.test");
    const id = await publishSite(owner, "Private");
    const stranger = await h.signIn("boundaries-stranger@example.test");
    for (const target of ["NOT-AN-ID", id]) {
      const response = await h.request(
        `/api/v1/account/comment-notices/${target}`,
        dashboard(stranger),
      );
      expect(response.status, target).toBe(404);
    }
  });
});
