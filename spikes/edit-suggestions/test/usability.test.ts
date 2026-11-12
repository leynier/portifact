// Typo fixes apply in most places (rule 11 of the second round). A small corpus here; the full one
// the record quotes runs in `bun run bench`.
import { describe, expect, it } from "vitest";
import { measure } from "./usability-probes.ts";

describe("typo fixes apply in most places", () => {
  it("measures each kind", () => {
    const results = measure(12);
    console.log("usability", JSON.stringify(results));
    for (const tally of Object.values(results)) expect(tally.probes).toBeGreaterThan(100);
    expect(results.markdown.certain / results.markdown.probes).toBeGreaterThan(0.8);
    expect(results.text.certain / results.text.probes).toBeGreaterThan(0.95);
    expect(results.html.certain / results.html.probes).toBeGreaterThan(0.95);
  });
});
