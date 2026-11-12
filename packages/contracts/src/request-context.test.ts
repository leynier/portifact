import { describe, expect, it } from "vitest";
import {
  BACKGROUND,
  CLI_CLIENT_ID,
  clientKindOf,
  parseSignInMethod,
  recordCredential,
  requestContextOf,
  signInMethodKind,
  signInMethodText,
  UNKNOWN_REQUEST,
} from "./request-context.ts";

const from = (headers: Record<string, string>) =>
  requestContextOf(new Request("https://app.portifact.com/api/v1/artifacts", { headers }));

const SSO_ID = `sso_${"a".repeat(32)}`;

describe("sign-in methods (decision 0021, SSO required)", () => {
  it("round-trips every method through its stored spelling", () => {
    for (const method of [
      { kind: "code" },
      { kind: "social", provider: "google" },
      { kind: "social", provider: "github" },
      { kind: "sso", providerId: SSO_ID },
    ] as const) {
      expect(parseSignInMethod(signInMethodText(method))).toEqual(method);
    }
  });

  it("reads anything it does not know as not known, never as a method", () => {
    for (const stored of [
      null,
      undefined,
      "",
      "otp",
      "sso:",
      "sso:sso_123",
      `sso:${SSO_ID}x`,
      `x-sso:${SSO_ID}`,
      "GOOGLE",
      42,
    ]) {
      expect(parseSignInMethod(stored)).toBeNull();
      expect(signInMethodKind(stored)).toBe("unknown");
    }
  });

  it("shows a method by its kind, never the provider's ID", () => {
    expect(signInMethodKind("code")).toBe("code");
    expect(signInMethodKind("github")).toBe("github");
    expect(signInMethodKind(`sso:${SSO_ID}`)).toBe("sso");
  });
});

describe("the request context", () => {
  it("says single sign-on is offered only when the Worker says so", () => {
    const request = new Request("https://app.portifact.com/");
    expect(requestContextOf(request, { sso: true })).toEqual({
      kind: "request",
      ip: null,
      sso: true,
    });
    expect(requestContextOf(request, { sso: false })).toEqual({ kind: "request", ip: null });
    expect(requestContextOf(request)).toEqual({ kind: "request", ip: null });
  });

  it("takes the address only from CF-Connecting-IP, trimmed", () => {
    expect(from({ "CF-Connecting-IP": "203.0.113.5" })).toEqual({
      kind: "request",
      ip: "203.0.113.5",
    });
    expect(from({ "cf-connecting-ip": "  2001:db8::5 " })).toEqual({
      kind: "request",
      ip: "2001:db8::5",
    });
  });

  it("knows no address when Cloudflare sent none, whatever a client claims", () => {
    expect(from({})).toEqual(UNKNOWN_REQUEST);
    expect(from({ "CF-Connecting-IP": "   " })).toEqual(UNKNOWN_REQUEST);
    expect(
      from({
        "X-Forwarded-For": "203.0.113.5",
        "True-Client-IP": "203.0.113.5",
        "X-Real-IP": "203.0.113.5",
      }),
    ).toEqual(UNKNOWN_REQUEST);
  });

  it("keeps the two fixed contexts apart and unchangeable", () => {
    expect(BACKGROUND).toEqual({ kind: "background" });
    expect(UNKNOWN_REQUEST).toEqual({ kind: "request", ip: null });
    expect(Object.isFrozen(BACKGROUND)).toBe(true);
    expect(Object.isFrozen(UNKNOWN_REQUEST)).toBe(true);
  });
});

describe("recording how a request authenticated", () => {
  const session = { kind: "session", userId: "u1", signedInAt: 1_000, method: null } as const;

  it("records the credential on the request's own context", () => {
    const context = requestContextOf(new Request("https://app.portifact.com/"));
    recordCredential(context, session);
    expect(context).toEqual({ kind: "request", ip: null, credential: session });
    // The same credential again (a route that looks the session up twice) keeps it.
    recordCredential(context, { ...session });
    expect(context).toMatchObject({ credential: session });
  });

  it("makes the credential unknown for good when a request presents two", () => {
    const context = requestContextOf(new Request("https://app.portifact.com/"));
    recordCredential(context, session);
    recordCredential(context, { ...session, signedInAt: 2_000 });
    expect(context).toMatchObject({ credential: null });
    recordCredential(context, session);
    expect(context).toMatchObject({ credential: null });
    const other = requestContextOf(new Request("https://app.portifact.com/"));
    recordCredential(other, session);
    recordCredential(other, { kind: "service_token", userId: "u1" });
    expect(other).toMatchObject({ credential: null });
    const users = requestContextOf(new Request("https://app.portifact.com/"));
    recordCredential(users, session);
    recordCredential(users, { ...session, userId: "u2" });
    expect(users).toMatchObject({ credential: null });
  });

  it("compares OAuth credentials by client and sign-in, and tokens by ID", () => {
    const token = {
      kind: "oauth",
      termsAccepted: true,
      userId: "u1",
      clientId: CLI_CLIENT_ID,
      client: "cli",
      signedInAt: null,
      method: null,
    } as const;
    const context = requestContextOf(new Request("https://app.portifact.com/"));
    recordCredential(context, token);
    recordCredential(context, { ...token });
    expect(context).toMatchObject({ credential: token });
    recordCredential(context, { ...token, clientId: "other", client: "oauth_apps" });
    expect(context).toMatchObject({ credential: null });
    const tokens = requestContextOf(new Request("https://app.portifact.com/"));
    recordCredential(tokens, { kind: "service_token", userId: "st_1" });
    recordCredential(tokens, { kind: "service_token", userId: "st_1" });
    expect(tokens).toMatchObject({ credential: { kind: "service_token", userId: "st_1" } });
  });

  it("compares credentials by how they signed in too", () => {
    const code = { ...session, method: { kind: "code" } } as const;
    const context = requestContextOf(new Request("https://app.portifact.com/"));
    recordCredential(context, code);
    recordCredential(context, { ...code, method: { kind: "code" } });
    expect(context).toMatchObject({ credential: code });
    recordCredential(context, { ...code, method: { kind: "sso", providerId: SSO_ID } });
    expect(context).toMatchObject({ credential: null });
    const unknown = requestContextOf(new Request("https://app.portifact.com/"));
    recordCredential(unknown, code);
    recordCredential(unknown, session);
    expect(unknown).toMatchObject({ credential: null });
  });

  it("never records on a background or frozen context", () => {
    recordCredential(BACKGROUND, session);
    recordCredential(UNKNOWN_REQUEST, session);
    expect(BACKGROUND).toEqual({ kind: "background" });
    expect(UNKNOWN_REQUEST).toEqual({ kind: "request", ip: null });
  });

  it("tells the first-party CLI from every other OAuth client by its seeded ID only", () => {
    expect(clientKindOf(CLI_CLIENT_ID)).toBe("cli");
    expect(clientKindOf("Portifact CLI")).toBe("oauth_apps");
    expect(clientKindOf("portifact-cli-api")).toBe("oauth_apps");
  });
});
