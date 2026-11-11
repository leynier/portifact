import { describe, expect, it } from "vitest";
import {
  BACKGROUND,
  CLI_CLIENT_ID,
  clientKindOf,
  recordCredential,
  requestContextOf,
  UNKNOWN_REQUEST,
} from "./request-context.ts";

const from = (headers: Record<string, string>) =>
  requestContextOf(new Request("https://app.portifact.com/api/v1/artifacts", { headers }));

describe("the request context", () => {
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
  const session = { kind: "session", userId: "u1", signedInAt: 1_000 } as const;

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
      userId: "u1",
      clientId: CLI_CLIENT_ID,
      client: "cli",
      signedInAt: null,
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
