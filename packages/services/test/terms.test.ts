// Who acts without the current terms, from the request's credential (docs/legal.md, "API and MCP
// clients"): only a person's OAuth token that says so, or a request whose credential became
// unknown, which fails closed.
import { env } from "cloudflare:test";
import { BACKGROUND, type Credential, type RequestContext } from "@portifact/contracts";
import { globalDb } from "@portifact/db";
import { describe, expect, it } from "vitest";
import { actsWithoutCurrentTerms, narrowingOnly } from "../src/terms.ts";

const oauth = (termsAccepted: boolean): Credential => ({
  kind: "oauth",
  userId: "u1",
  clientId: "portifact-cli",
  client: "cli",
  signedInAt: null,
  method: null,
  termsAccepted,
});

const on = (context: RequestContext) => actsWithoutCurrentTerms(globalDb(env.DB, context));

describe("actsWithoutCurrentTerms", () => {
  it("is true for a person's token without the current terms, and for an unknown credential", () => {
    expect(on({ kind: "request", ip: null, credential: oauth(false) })).toBe(true);
    expect(on({ kind: "request", ip: null, credential: null })).toBe(true);
  });

  it("is false for everyone else", () => {
    expect(on({ kind: "request", ip: null, credential: oauth(true) })).toBe(false);
    expect(
      on({
        kind: "request",
        ip: null,
        credential: { kind: "session", userId: "u1", signedInAt: 1, method: null },
      }),
    ).toBe(false);
    expect(
      on({ kind: "request", ip: null, credential: { kind: "service_token", userId: "st_1" } }),
    ).toBe(false);
    expect(on({ kind: "request", ip: null })).toBe(false);
    expect(on(BACKGROUND)).toBe(false);
  });

  it("refuses with terms_not_accepted, naming the dashboard", () => {
    expect(narrowingOnly()).toMatchObject({
      ok: false,
      code: "terms_not_accepted",
      message: expect.stringContaining("open the Portifact dashboard in a browser"),
    });
  });
});
