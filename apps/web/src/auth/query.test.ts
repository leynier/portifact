import { describe, expect, it } from "vitest";
import { loginUrl, safeNext, signedOAuthQuery, singleParam } from "./query.ts";

const ORIGIN = "https://app.portifact.com";

describe("signed OAuth query", () => {
  it("keeps the signature, the signed names and their values only", () => {
    const search =
      "?client_id=c1&scope=artifacts%3Aread&sig=abc&ba_param=client_id&ba_param=scope&ba_param=ba_param&extra=1";
    const query = signedOAuthQuery(search) ?? "";
    const params = new URLSearchParams(query);
    expect(params.get("client_id")).toBe("c1");
    expect(params.get("scope")).toBe("artifacts:read");
    expect(params.get("sig")).toBe("abc");
    expect(params.getAll("ba_param")).toEqual(["client_id", "scope", "ba_param"]);
    expect(params.has("extra")).toBe(false);
  });

  it("is absent when the page was not opened by an authorization request", () => {
    expect(signedOAuthQuery("")).toBeUndefined();
    expect(signedOAuthQuery("?next=%2Fdevice")).toBeUndefined();
    expect(signedOAuthQuery("?sig=abc&client_id=c1")).toBeUndefined();
  });

  it("reads a parameter only when it appears exactly once", () => {
    expect(singleParam("client_id=a", "client_id")).toBe("a");
    expect(singleParam("client_id=a&client_id=b", "client_id")).toBeUndefined();
    expect(singleParam("", "client_id")).toBeUndefined();
  });
});

describe("next after sign-in", () => {
  it("accepts the device page with its code", () => {
    expect(safeNext("?next=%2Fdevice%3Fuser_code%3DABCD-EFGH", ORIGIN)).toBe(
      "/device?user_code=ABCD-EFGH",
    );
  });

  it("refuses other sites, other paths and tricks that leave the origin", () => {
    for (const next of [
      "https://evil.example/device",
      "//evil.example/device",
      "/\\evil.example/device",
      "/consent",
      "/login",
      "device",
      "",
    ]) {
      expect(safeNext(`?${new URLSearchParams({ next })}`, ORIGIN), next).toBeUndefined();
    }
    expect(safeNext("", ORIGIN)).toBeUndefined();
  });

  it("builds a login URL that returns to the given path", () => {
    expect(loginUrl("/device?user_code=X")).toBe("/login?next=%2Fdevice%3Fuser_code%3DX");
  });
});
