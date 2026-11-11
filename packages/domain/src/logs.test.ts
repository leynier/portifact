import { describe, expect, it, vi } from "vitest";
import { CodedError, errorLabel, logEvent, logSummary, PORTIFACT_ERROR_CODES } from "./logs.ts";

const USER_TEXT = [
  "Confidential merger plan",
  "ada@example.com",
  "/docs/secret.html",
  "x".repeat(8),
];

class R2Error extends Error {}

describe("errorLabel", () => {
  it.each([
    [
      "a plain Error with user text",
      new Error(`Confidential merger plan for ada@example.com`),
      "Error",
    ],
    [
      "a TypeError with a URL",
      new TypeError("fetch failed for https://a.test/docs/secret.html"),
      "TypeError",
    ],
    ["a coded Portifact error", new CodedError("ANALYTICS_HTTP", 401), "Error:ANALYTICS_HTTP:401"],
    [
      "a coded error with details",
      new CodedError("CF_HOSTNAMES_HTTP", 409, [1406, 1407]),
      "Error:CF_HOSTNAMES_HTTP:409:1406:1407",
    ],
    [
      "a coded error without a status",
      new CodedError("BUCKET_NOT_BOUND"),
      "Error:BUCKET_NOT_BOUND",
    ],
    [
      "a D1 constraint error with user text",
      new Error(
        "D1_ERROR: UNIQUE constraint failed: artifacts.name = 'Confidential merger plan': SQLITE_CONSTRAINT",
      ),
      "Error:D1_ERROR:SQLITE_CONSTRAINT",
    ],
    [
      "a D1 error without a result code",
      new Error("D1_ERROR: no such table: ada@example.com"),
      "Error:D1_ERROR",
    ],
    [
      "an R2 error",
      new R2Error("put: Object key /docs/secret.html is too long (10025)"),
      "Error:r2_10025",
    ],
    [
      "Email Service's suppression",
      new Error("E_RECIPIENT_SUPPRESSED"),
      "Error:E_RECIPIENT_SUPPRESSED",
    ],
    [
      "a hostile message that looks like a code",
      new Error("ADA_LOVELACE: SQLITE_CONSTRAINT (10025x)"),
      "Error",
    ],
    ["an SQLite name outside a D1 error", new Error("Plan SQLITE_CONSTRAINT"), "Error"],
    ["a made-up SQLite name", new Error("D1_ERROR: SQLITE_ADA"), "Error:D1_ERROR"],
    ["a thrown string", "ada@example.com", "string"],
    ["a thrown object", { message: "Confidential merger plan" }, "object"],
    ["undefined", undefined, "undefined"],
  ])("labels %s", (_case, error, label) => {
    const result = errorLabel(error);
    expect(result).toBe(label);
    for (const text of USER_TEXT) expect(result).not.toContain(text);
  });

  it("never keeps a hostile error name", () => {
    const error = new Error("x");
    error.name = "ada@example.com";
    expect(errorLabel(error)).toBe("Error");
  });

  it("lists every code once", () => {
    expect(new Set(PORTIFACT_ERROR_CODES).size).toBe(PORTIFACT_ERROR_CODES.length);
  });
});

describe("logEvent and logSummary", () => {
  it("write one JSON line at the level asked, the event first", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      logEvent("log", "job", { id: 3, topic: "purge_artifact", outcome: "done" });
      logEvent("error", "job_failed", { error: errorLabel(new CodedError("DOH_RCODE", 2)) });
      logEvent("warn", "nothing");
      logSummary("log", "maintenance", { archived: 1, regions: { eu: { archived: 0 } } });
      expect(log.mock.calls).toEqual([
        [JSON.stringify({ event: "job", id: 3, topic: "purge_artifact", outcome: "done" })],
        [JSON.stringify({ event: "maintenance", archived: 1, regions: { eu: { archived: 0 } } })],
      ]);
      expect(error.mock.calls).toEqual([
        [JSON.stringify({ event: "job_failed", error: "Error:DOH_RCODE:2" })],
      ]);
      expect(warn.mock.calls).toEqual([[JSON.stringify({ event: "nothing" })]]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("refuses free text where an enum, a label or a literal event is required, by type", () => {
    const silent = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const name: string = "Confidential merger plan";
      // @ts-expect-error `reason` must be a literal union, never `string`
      logEvent("log", "x", { reason: name });
      // @ts-expect-error `error` takes only what errorLabel returns
      logEvent("log", "x", { error: name });
      // @ts-expect-error the event must be a string literal
      logEvent("log", name);
      // @ts-expect-error a field outside LogFields
      logEvent("log", "x", { email: name });
      expect(silent).toHaveBeenCalledTimes(4);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
