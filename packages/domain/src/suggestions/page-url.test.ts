import { describe, expect, it } from "vitest";
import { planPageUrl } from "./page-url.ts";

describe("the URL a planned page is served at", () => {
  it("is the HTML file's path on its .dev origin, and the root for a document", () => {
    expect(planPageUrl("html", "k7d2qm4xab", "portifact.dev", "index.html")).toBe(
      "https://k7d2qm4xab.portifact.dev/index.html",
    );
    expect(planPageUrl("html", "k7d2qm4xab", "portifact.dev", "docs/a b#?.html")).toBe(
      "https://k7d2qm4xab.portifact.dev/docs/a%20b%23%3F.html",
    );
    expect(planPageUrl("markdown", "k7d2qm4xab", "portifact.dev", "notes/index.md")).toBe(
      "https://k7d2qm4xab.portifact.dev/",
    );
    expect(planPageUrl("text", "k7d2qm4xab", "portifact.dev", "notes.txt")).toBe(
      "https://k7d2qm4xab.portifact.dev/",
    );
  });
});
