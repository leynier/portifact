import { AUDIT_LIMITS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  auditActorView,
  auditCutoff,
  auditDetail,
  auditWindow,
  decodeAuditCursor,
  emailDomain,
  emailDomains,
  encodeAuditCursor,
  newAuditEventId,
} from "./audit.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const DAY = 86_400_000;

describe("event details", () => {
  it("passes a detail the catalog allows", () => {
    expect(auditDetail("artifact.published", { version: 2, first: false })).toEqual({
      version: 2,
      first: false,
    });
    expect(
      auditDetail("access.changed", { readersAdded: 1, readerDomains: ["corp.example"] }),
    ).toEqual({ readersAdded: 1, readerDomains: ["corp.example"] });
  });

  it("throws for anything else: extra fields, addresses, wrong shapes", () => {
    expect(() =>
      auditDetail("artifact.renewed", { note: "x" } as unknown as Record<string, never>),
    ).toThrow("Invalid detail for audit event artifact.renewed");
    expect(() => auditDetail("access.changed", { readerDomains: ["ana@corp.example"] })).toThrow();
    expect(() =>
      auditDetail("member.invited", { role: "admin", emailDomain: "Corp.Example" }),
    ).toThrow();
    expect(() => auditDetail("artifact.published", { version: 0, first: true })).toThrow();
  });
});

describe("email domains", () => {
  it("keeps the distinct lowercase domains, sorted and capped", () => {
    expect(emailDomains(["b@Corp.Example", "a@corp.example", "c@other.example"])).toEqual([
      "corp.example",
      "other.example",
    ]);
    const many = Array.from({ length: 15 }, (_, i) => `x@d${String(i).padStart(2, "0")}.example`);
    const domains = emailDomains(many);
    expect(domains).toHaveLength(AUDIT_LIMITS.readerDomains);
    expect(domains[0]).toBe("d00.example");
  });

  it("takes the part after the last @ and drops what is not a domain", () => {
    expect(emailDomains(["odd@name@corp.example", "nodomain", "x@bad domain"])).toEqual([
      "corp.example",
    ]);
    expect(emailDomains(["x@"])).toEqual([]);
    expect(emailDomain("ana@corp.example")).toBe("corp.example");
    expect(emailDomain("broken")).toBe("invalid");
  });
});

describe("the window a query reads", () => {
  it("never reaches past the retention, and ends now", () => {
    expect(auditCutoff(90, NOW)).toBe(NOW - 90 * DAY);
    expect(auditWindow({}, 90, NOW)).toEqual({
      ok: true,
      value: { from: NOW - 90 * DAY, to: NOW + 1 },
    });
    const old = new Date(NOW - 200 * DAY).toISOString();
    expect(auditWindow({ from: old }, 90, NOW)).toEqual({
      ok: true,
      value: { from: NOW - 90 * DAY, to: NOW + 1 },
    });
  });

  it("keeps a narrower range as asked", () => {
    const from = new Date(NOW - 2 * DAY).toISOString();
    const to = new Date(NOW - DAY).toISOString();
    expect(auditWindow({ from, to }, 90, NOW)).toEqual({
      ok: true,
      value: { from: NOW - 2 * DAY, to: NOW - DAY },
    });
    expect(auditWindow({ to: new Date(NOW + DAY).toISOString() }, 90, NOW)).toEqual({
      ok: true,
      value: { from: NOW - 90 * DAY, to: NOW + 1 },
    });
  });

  it("refuses a range that ends before it starts, or is empty", () => {
    const at = new Date(NOW - DAY).toISOString();
    const refused = {
      ok: false,
      code: "invalid_input",
      message: "The start of the range must be before its end.",
    };
    expect(auditWindow({ from: at, to: at }, 90, NOW)).toEqual(refused);
    expect(auditWindow({ from: at, to: new Date(NOW - 2 * DAY).toISOString() }, 90, NOW)).toEqual(
      refused,
    );
  });
});

describe("cursors", () => {
  it("round-trips a position, URL safe", () => {
    const cursor = encodeAuditCursor({ at: NOW, id: "ae_0123456789abcdef01234567" });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeAuditCursor(cursor)).toEqual({
      ok: true,
      value: { at: NOW, id: "ae_0123456789abcdef01234567" },
    });
    // Characters that base64 would write as + and / come back.
    const odd = encodeAuditCursor({ at: 1, id: "??>>~~" });
    expect(decodeAuditCursor(odd)).toEqual({ ok: true, value: { at: 1, id: "??>>~~" } });
  });

  it("refuses anything that is not one", () => {
    const invalid = { ok: false, code: "invalid_input", message: "The cursor is not valid." };
    expect(decodeAuditCursor("%%%")).toEqual(invalid);
    const encode = (value: unknown) => btoa(JSON.stringify(value));
    expect(decodeAuditCursor(encode([1, "a", 3]))).toEqual(invalid);
    expect(decodeAuditCursor(encode([1.5, "a"]))).toEqual(invalid);
    expect(decodeAuditCursor(encode([1, 2]))).toEqual(invalid);
    expect(decodeAuditCursor(encode([1, ""]))).toEqual(invalid);
    expect(decodeAuditCursor(encode([1, "x".repeat(101)]))).toEqual(invalid);
    expect(decodeAuditCursor(encode({ at: 1, id: "a" }))).toEqual(invalid);
    expect(decodeAuditCursor(encode([1, "x".repeat(100)]))).toEqual({
      ok: true,
      value: { at: 1, id: "x".repeat(100) },
    });
  });
});

describe("who acted", () => {
  const names = new Map([["u_1", "Ada"]]);

  it("shows a current member by name and anyone else as a removed member", () => {
    expect(auditActorView("user", "u_1", names)).toEqual({
      type: "member",
      id: "u_1",
      name: "Ada",
    });
    expect(auditActorView("user", "u_2", names)).toEqual({ type: "removed_member", id: "u_2" });
  });

  it("names the operator and jobs by what they are", () => {
    expect(auditActorView("operator", null, names)).toEqual({ type: "operator" });
    expect(auditActorView("operator", "u_1", names)).toEqual({ type: "operator" });
    expect(auditActorView("system", null, names)).toEqual({ type: "system" });
    expect(auditActorView("user", null, names)).toEqual({ type: "system" });
  });
});

describe("event IDs", () => {
  it("are new each time, with the ae_ prefix", () => {
    const one = newAuditEventId();
    expect(one).toMatch(/^ae_[0-9a-f]{24}$/);
    expect(newAuditEventId()).not.toBe(one);
  });
});
