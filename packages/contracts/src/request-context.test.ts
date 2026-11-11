import { describe, expect, it } from "vitest";
import { BACKGROUND, requestContextOf, UNKNOWN_REQUEST } from "./request-context.ts";

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
