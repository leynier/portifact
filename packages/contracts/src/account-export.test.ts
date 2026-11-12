import { describe, expect, it } from "vitest";
import { ACCOUNT_EXPORT_PATH, accountExportFileName } from "./account-export.ts";

describe("the account export's file name", () => {
  it("is portifact-export-<UTC date>.json", () => {
    expect(accountExportFileName(Date.UTC(2026, 10, 12, 23, 59))).toBe(
      "portifact-export-2026-11-12.json",
    );
    expect(accountExportFileName(Date.UTC(2026, 10, 13, 0, 0))).toBe(
      "portifact-export-2026-11-13.json",
    );
    expect(ACCOUNT_EXPORT_PATH).toBe("/api/v1/account/export");
  });
});
