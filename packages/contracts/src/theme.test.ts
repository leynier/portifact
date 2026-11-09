import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { THEME_COOKIE, THEME_SCRIPT, THEME_SCRIPT_HASH, THEME_STORAGE_KEY } from "./theme.ts";

describe("theme script", () => {
  it("is allowed by a hash of its exact text", () => {
    const digest = createHash("sha256").update(THEME_SCRIPT).digest("base64");
    // A change to the script needs this hash updated, and with it apps/web/public/_headers.
    expect(THEME_SCRIPT_HASH).toBe(`'sha256-${digest}'`);
  });

  it("reads the shared cookie first, in its own try, then this origin's storage", () => {
    expect(THEME_SCRIPT).toContain(`try{t=("; "+document.cookie).split("; ${THEME_COOKIE}=")[1]`);
    expect(THEME_SCRIPT).toContain(
      `if(t!=="system"&&t!=="light"&&t!=="dark")t=localStorage.getItem("${THEME_STORAGE_KEY}");`,
    );
  });

  it("reads the stored choice and only accepts Light or Dark", () => {
    expect(THEME_SCRIPT).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
    expect(THEME_SCRIPT).toContain('if(t!=="light"&&t!=="dark")return;');
  });

  it("never fails the page when storage is blocked", () => {
    expect(THEME_SCRIPT).toMatch(/^\(function\(\)\{try\{/);
    expect(THEME_SCRIPT).toMatch(/\}catch\(e\)\{\}\}\)\(\);$/);
  });

  it("is a single line that cannot close the script element it sits in", () => {
    expect(THEME_SCRIPT).not.toContain("\n");
    expect(THEME_SCRIPT).not.toContain("</");
  });
});
