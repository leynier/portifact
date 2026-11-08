import { env } from "cloudflare:workers";
import { LIMITS, PREVIEW_LIMIT } from "@portifact/contracts";
import { RENDERER_VERSION } from "@portifact/render";
import { describe, expect, it } from "vitest";
import { tokenClient } from "./api-client.ts";
import { createHarness, ORIGIN } from "./harness.ts";

const PREVIEW = "/api/v1/documents/preview";

function session(cookie: string, body: unknown, extra: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      origin: ORIGIN,
      "content-type": "application/json",
      ...extra,
    },
    body: JSON.stringify(body),
  };
}

describe("document preview", () => {
  it("renders Markdown for the signed-in dashboard like a commit would, storing nothing", async () => {
    const h = createHarness();
    const cookie = await h.signIn("preview-md@example.test");
    const before = await env.ARTIFACTS.list();
    const response = await h.request(
      PREVIEW,
      session(cookie, { type: "markdown", name: "Plan", source: "# Hi\n\n<script>x</script>" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json<{ html: string; rendererVersion: string }>();
    expect(body.rendererVersion).toBe(RENDERER_VERSION);
    expect(body.html).toContain("<title>Plan</title>");
    expect(body.html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(body.html).not.toContain("<script>");
    expect((await env.ARTIFACTS.list()).objects.length).toBe(before.objects.length);
  });

  it("takes a bearer token with artifacts:write and refuses one without it", async () => {
    const h = createHarness();
    const writer = await tokenClient(h, "preview-token@example.test");
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "text", name: "Notes", source: "plain" }),
    };
    expect((await writer.call(PREVIEW, init)).status).toBe(200);
    const reader = await tokenClient(h, "preview-reader@example.test", "artifacts:read");
    const refused = await reader.call(PREVIEW, init);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toContain("artifacts:write");
    expect((await h.request(PREVIEW, { ...init })).status).toBe(401);
  });

  it("refuses session requests from other origins", async () => {
    const h = createHarness();
    const cookie = await h.signIn("preview-csrf@example.test");
    const body = { type: "text", name: "N", source: "x" };
    for (const extra of [
      { origin: "https://k7d2qm4xab.portifact.dev" },
      { "sec-fetch-site": "same-site" },
    ]) {
      expect((await h.request(PREVIEW, session(cookie, body, extra))).status).toBe(403);
    }
  });

  it("refuses invalid input: unknown types, extra fields, oversized and binary sources", async () => {
    const h = createHarness();
    const cookie = await h.signIn("preview-invalid@example.test");
    for (const body of [
      { type: "site", name: "N", source: "x" },
      { type: "text", name: "", source: "x" },
      { type: "text", name: "N", source: "x", ownerId: "someone" },
      { type: "text", name: "N", source: "é".repeat(LIMITS.documentBytes / 2 + 1) },
      { type: "markdown", name: "N", source: "a\u0000b" },
    ]) {
      const response = await h.request(PREVIEW, session(cookie, body));
      expect(response.status).toBe(400);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe("invalid_input");
    }
  });

  it("limits previews per user and window", async () => {
    const h = createHarness();
    const cookie = await h.signIn("preview-limit@example.test");
    const other = await h.signIn("preview-limit-other@example.test");
    const body = { type: "text", name: "N", source: "x" };
    const me = await (
      await h.request("/api/v1/artifacts", {
        headers: { cookie, "sec-fetch-site": "same-origin" },
      })
    ).status;
    expect(me).toBe(200);
    // Fill the window directly, then one more request goes over the limit.
    const userId = (
      await env.DB.prepare("select id from users where email = ?1")
        .bind("preview-limit@example.test")
        .first<{ id: string }>()
    )?.id;
    await env.DB.prepare(
      "insert into rate_limits (key, window_start, count) values (?1, ?2, ?3) on conflict (key) do update set count = ?3, window_start = ?2",
    )
      .bind(`preview:${userId}`, Date.now(), PREVIEW_LIMIT.requests - 1)
      .run();
    expect((await h.request(PREVIEW, session(cookie, body))).status).toBe(200);
    const limited = await h.request(PREVIEW, session(cookie, body));
    expect(limited.status).toBe(429);
    expect((await limited.json<{ error: { code: string } }>()).error.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await h.request(PREVIEW, session(other, body))).status).toBe(200);
  });
});
