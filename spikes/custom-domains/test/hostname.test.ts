import { describe, expect, it } from "vitest";
import { classifyHost, cookieCleanupDomain, normalizeHostname } from "../src/hostname.ts";

describe("normalizeHostname", () => {
  it.each([
    ["Docs.Example.COM", "docs.example.com"],
    ["docs.example.com.", "docs.example.com"],
    ["  docs.example.com ", "docs.example.com"],
    ["bücher.example.de", "xn--bcher-kva.example.de"],
    ["example.com", "example.com"],
  ])("accepts %s as %s", (input, hostname) => {
    expect(normalizeHostname(input)).toEqual({ ok: true, hostname });
  });

  it.each([
    ["*.example.com", "wildcard"],
    ["192.0.2.1", "ip_literal"],
    ["[2001:db8::1]", "invalid"],
    ["docs.example.com:8443", "invalid"],
    ["https://docs.example.com", "invalid"],
    ["user@docs.example.com", "invalid"],
    ["docs.example.com/path", "invalid"],
    ["", "invalid"],
    ["exa_mple.com", "invalid"],
    ["-docs.example.com", "invalid"],
    [`${"a".repeat(64)}.example.com`, "invalid"],
    ["localhost", "single_label"],
    ["portifact.dev", "reserved"],
    ["abcdefghij.portifact.dev", "reserved"],
    ["app.portifact.com", "reserved"],
    ["x.portifact.test", "reserved"],
    ["portifact-login.example.com", "lookalike"],
    ["login.myportifact.net", "lookalike"],
  ])("refuses %s (%s)", (input, error) => {
    expect(normalizeHostname(input)).toEqual({ ok: false, error });
  });
});

describe("classifyHost", () => {
  it("keeps today's artifact hosts", () => {
    expect(classifyHost("abcdefghij.portifact.dev", "portifact.dev")).toEqual({
      kind: "artifact",
      artifactId: "abcdefghij",
    });
  });

  it.each([
    "portifact.dev",
    "domains.portifact.dev",
    "a.abcdefghij.portifact.dev",
    "ABCDEFGHIJ.portifact.dev",
  ])("serves nothing on %s", (host) => {
    expect(classifyHost(host, "portifact.dev")).toEqual({ kind: "none" });
  });

  it("treats any other valid name as a custom host, and refuses odd ones", () => {
    expect(classifyHost("docs.example.com", "portifact.dev")).toEqual({
      kind: "custom",
      hostname: "docs.example.com",
    });
    expect(classifyHost("app.portifact.com", "portifact.dev")).toEqual({ kind: "none" });
    expect(classifyHost("192.0.2.1", "portifact.dev")).toEqual({ kind: "none" });
  });

  it("clears sibling cookies only on the content domain", () => {
    expect(cookieCleanupDomain("abcdefghij.portifact.dev", "portifact.dev")).toBe("portifact.dev");
    expect(cookieCleanupDomain("docs.example.com", "portifact.dev")).toBeNull();
  });
});
