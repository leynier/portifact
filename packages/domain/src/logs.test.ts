import { describe, expect, it } from "vitest";
import { errorLabel } from "./logs.ts";

describe("errorLabel", () => {
  it("names the error and nothing of a free-text message", () => {
    expect(errorLabel(new Error("artifact Confidential plan of ada@example.com"))).toBe("Error");
    expect(errorLabel(new TypeError("fetch failed for https://a.test/secret/path"))).toBe(
      "TypeError",
    );
    expect(errorLabel(new Error("analytics: HTTP 403"))).toBe("Error");
  });

  it("keeps a leading upper-case code, and only the code", () => {
    expect(errorLabel(new Error("D1_ERROR: UNIQUE constraint failed: artifacts.name"))).toBe(
      "Error:D1_ERROR",
    );
    expect(errorLabel(new Error("E_RECIPIENT_SUPPRESSED"))).toBe("Error:E_RECIPIENT_SUPPRESSED");
    expect(errorLabel(new Error("AB: too short to be a code"))).toBe("Error");
    expect(errorLabel(new Error("D1_ERROR and then text"))).toBe("Error");
  });

  it("names what is not an error by its type", () => {
    expect(errorLabel("ada@example.com")).toBe("string");
    expect(errorLabel(undefined)).toBe("undefined");
    expect(errorLabel({ message: "x" })).toBe("object");
  });
});
