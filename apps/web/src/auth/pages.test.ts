import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pages = ["login", "device", "consent", "report"].map((name) => ({
  name,
  html: readFileSync(new URL(`../../${name}.html`, import.meta.url), "utf8"),
}));

describe("auth page markup", () => {
  for (const { name, html } of pages) {
    describe(name, () => {
      it("has the landmarks, skip link and wordmark", () => {
        expect(html).toMatch(/<html lang="en"[\s>]/);
        expect(html).toContain('href="#main"');
        expect(html).toContain('<main id="main"');
        expect(html.match(/<h1\b/g)).toHaveLength(1);
        expect(html).toContain('alt="portifact"');
        expect(html).toContain('<meta name="robots" content="noindex"');
      });

      it("labels every input and links each error element by id", () => {
        for (const input of html.match(/<input\b[^>]*>/g) ?? []) {
          const id = /\bid="([^"]+)"/.exec(input)?.[1];
          expect(html).toContain(`for="${id}"`);
          expect(html).toContain(`id="${id}-error"`);
        }
      });

      it("has one error summary that takes focus and one polite status region at most", () => {
        expect(html).toMatch(/id="error-summary" role="alert" tabindex="-1"/);
        expect((html.match(/role="status"/g) ?? []).length).toBeLessThanOrEqual(1);
      });

      it("loads no inline script or style, so the strict CSP holds", () => {
        expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
        expect(html).not.toMatch(/<style\b/);
        expect(html).not.toMatch(/\son[a-z]+=/);
      });

      it("keeps headings and buttons free of trailing periods and em dashes", () => {
        for (const match of html.matchAll(
          /<(h[1-6]|button|label|title)\b[^>]*>([\s\S]*?)<\/\1>/g,
        )) {
          const text = (match[2] ?? "").replace(/<[^>]+>/g, "").trim();
          expect(text).not.toMatch(/\.$/);
        }
        expect(html).not.toContain("—");
      });
    });
  }
});
