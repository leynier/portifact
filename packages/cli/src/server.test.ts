import { describe, expect, it } from "vitest";
import { CliError } from "./errors.ts";
import { DEFAULT_APP_ORIGIN, resolveServer } from "./server.ts";

describe("resolveServer", () => {
  it("uses app.portifact.com by default", () => {
    for (const env of [{}, { PORTIFACT_APP_ORIGIN: "  " }]) {
      expect(resolveServer(env)).toEqual({
        origin: DEFAULT_APP_ORIGIN,
        authBase: "https://app.portifact.com/api/auth",
        apiResource: "https://app.portifact.com/api/v1",
        overridden: false,
      });
    }
  });

  it("accepts an https origin or http on the local machine", () => {
    expect(resolveServer({ PORTIFACT_APP_ORIGIN: "https://staging.example/" })).toMatchObject({
      origin: "https://staging.example",
      apiResource: "https://staging.example/api/v1",
      overridden: true,
    });
    for (const origin of ["http://localhost:8787", "http://127.0.0.1:9", "http://[::1]:80"]) {
      expect(resolveServer({ PORTIFACT_APP_ORIGIN: origin }).overridden).toBe(true);
    }
    expect(resolveServer({ PORTIFACT_APP_ORIGIN: DEFAULT_APP_ORIGIN }).overridden).toBe(false);
  });

  it("refuses origins that would send tokens in clear text, to another path or with credentials", () => {
    for (const value of [
      "http://staging.example",
      "ftp://localhost",
      "not a url",
      "https://user:pass@staging.example",
      "https://staging.example/api",
      "https://staging.example/?x=1",
      "https://staging.example/#x",
    ]) {
      expect(() => resolveServer({ PORTIFACT_APP_ORIGIN: value }), value).toThrow(CliError);
    }
    try {
      resolveServer({ PORTIFACT_APP_ORIGIN: "https://user:secret@staging.example" });
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
      expect(String(error)).not.toContain("secret");
    }
  });
});
