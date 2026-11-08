// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { axeViolations } from "@portifact/ui/testing";
import { describe, expect, it } from "vitest";

// happy-dom replaces the global URL, so resolve the path from the module URL string.
const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../index.html"), "utf8");

describe("landing page accessibility", () => {
  it("has no axe violations", async () => {
    document.documentElement.lang = "en";
    document.title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
    document.body.innerHTML = /<body\b[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
    expect(document.querySelector("main")).not.toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
