import { CREDENTIALS_SCOPE, OAuthScope } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { browserApi, currentUserEmail, field } from "./api.ts";
import { messages } from "./messages.ts";
import { DESCRIBED_SCOPES, describeResource, describeScopes } from "./scopes.ts";

describe("browser API", () => {
  it("calls the auth API on the same origin with JSON and the session cookie", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const api = browserApi(async (url, init) => {
      seen.push(init ? { url, init } : { url });
      return Response.json({ ok: true }, { status: 201 });
    });
    expect(await api.post("/sign-out", { a: 1 })).toEqual({ status: 201, body: { ok: true } });
    expect(seen[0]?.url).toBe("/api/auth/sign-out");
    expect(seen[0]?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      body: '{"a":1}',
    });
    expect(await api.get("/get-session")).toEqual({ status: 201, body: { ok: true } });
    expect(seen[1]?.init?.method).toBe("GET");
  });

  it("sends the page's language so the Worker writes its emails in it", async () => {
    const headers: Headers[] = [];
    const record = async (_url: string, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return Response.json({ success: true });
    };
    const spanish = browserApi(record, { locale: "es" });
    await spanish.post("/email-otp/send-verification-otp", { email: "a@example.test" });
    await spanish.get("/get-session");
    expect(headers.map((sent) => sent.get("accept-language"))).toEqual(["es", "es"]);
    expect(headers[0]?.get("content-type")).toBe("application/json");

    await browserApi(record).get("/get-session");
    expect(headers[2]?.has("accept-language")).toBe(false);
  });

  it("returns a null body when the response is not JSON", async () => {
    const api = browserApi(async () => new Response("not json", { status: 502 }));
    expect(await api.get("/x")).toEqual({ status: 502, body: null });
  });

  it("reports a network failure as status 0", async () => {
    const api = browserApi(async () => {
      throw new TypeError("offline");
    });
    expect(await api.get("/x")).toEqual({ status: 0, body: null });
  });

  it("reads the signed-in email, or nothing without a session", async () => {
    const answer = (status: number, body: unknown) =>
      browserApi(async () => Response.json(body, { status }));
    expect(await currentUserEmail(answer(200, { user: { email: "a@example.test" } }))).toBe(
      "a@example.test",
    );
    expect(await currentUserEmail(answer(200, null))).toBeUndefined();
    expect(await currentUserEmail(answer(200, { user: null }))).toBeUndefined();
    expect(await currentUserEmail(answer(401, { user: { email: "x" } }))).toBeUndefined();
  });

  it("reads only string fields", () => {
    expect(field({ url: "/x" }, "url")).toBe("/x");
    expect(field({ url: 1 }, "url")).toBeUndefined();
    expect(field(null, "url")).toBeUndefined();
    expect(field("text", "url")).toBeUndefined();
  });
});

describe("scope descriptions", () => {
  it("describes every product scope, the CLI's credentials scope and offline access in plain language", () => {
    expect(DESCRIBED_SCOPES).toEqual([...OAuthScope.options, CREDENTIALS_SCOPE, "offline_access"]);
    for (const line of describeScopes(DESCRIBED_SCOPES.join(" "))) {
      expect(line).not.toMatch(/[:_]/);
      expect(line).not.toMatch(/\.$/);
    }
  });

  it("keeps the requested order, drops duplicates and names unknown scopes", () => {
    expect(describeScopes("artifacts:delete  artifacts:read artifacts:delete admin")).toEqual([
      "Archive and delete your artifacts",
      "See your artifacts, their settings and their versions",
      'Use the permission "admin"',
    ]);
    expect(describeScopes("")).toEqual([]);
  });

  it("names Portifact's resources and shows any other resource as given", () => {
    const origin = "https://app.portifact.com";
    expect(describeResource(`${origin}/api/v1`, origin)).toBe("Portifact API");
    expect(describeResource(`${origin}/mcp`, origin)).toBe("Portifact MCP");
    expect(describeResource("https://other.example/x", origin)).toBe("https://other.example/x");
  });
});

describe("messages", () => {
  it("follow the writing style: no em dashes", () => {
    const all = JSON.stringify(messages) + messages.codeSent("a") + messages.redirectHost("h");
    expect(all).not.toContain("—");
  });
});
