import { readFileSync } from "node:fs";
import { TERMS_VERSION } from "@portifact/contracts/terms-version";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`../${name}.html`, import.meta.url), "utf8");

const LEGAL = [
  { slug: "terms", title: "Terms of Service" },
  { slug: "privacy", title: "Privacy Policy" },
  { slug: "acceptable-use", title: "Acceptable Use Policy" },
];

const EFFECTIVE = new Date(`${TERMS_VERSION}T00:00:00Z`).toLocaleDateString("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function legalLinks(html: string): string[] {
  const nav = /<nav aria-label="Legal"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
  return [...nav.matchAll(/href="([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("legal pages", () => {
  for (const { slug, title } of LEGAL) {
    describe(slug, () => {
      const html = read(slug);

      it("has the landmarks, one h1 and its title", () => {
        expect(html).toMatch(/<html lang="en"[\s>]/);
        expect(html).toContain('href="#main"');
        expect(html).toContain('<main id="main"');
        expect(html.match(/<h1\b/g)).toHaveLength(1);
        expect(html).toContain(`>${title}</h1>`);
        expect(html).toContain(`<title>${title}: Portifact</title>`);
        expect(html).toContain(`<link rel="canonical" href="https://portifact.com/${slug}" />`);
        for (const img of html.match(/<img\b[^>]*>/g) ?? []) expect(img).toMatch(/\balt="[^"]+"/);
      });

      it("shows the current version and date, with no draft notice", () => {
        expect(html).not.toContain("Draft pending legal review");
        expect(html).toContain(`<span data-terms-version>${TERMS_VERSION}</span>`);
        expect(html).toContain(`<time datetime="${TERMS_VERSION}">${EFFECTIVE}</time>`);
      });

      it("links every table of contents entry to a section heading", () => {
        const toc = /<nav aria-labelledby="toc-heading"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
        const targets = [...toc.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
        expect(targets.length).toBeGreaterThan(3);
        for (const id of targets) {
          expect(html).toContain(`<section id="${id}" aria-labelledby="${id}-heading"`);
          expect(html).toContain(`<h2 id="${id}-heading"`);
        }
      });

      it("links the three legal pages from its footer and marks itself as current", () => {
        expect(legalLinks(html)).toEqual(["/terms", "/privacy", "/acceptable-use"]);
        expect(html).toMatch(new RegExp(`href="/${slug}"[^>]*aria-current="page"`));
      });

      it("loads no script, so it works without JavaScript under the strict CSP", () => {
        expect(html).not.toMatch(/<script\b/);
        expect(html).not.toMatch(/<style\b/);
        expect(html).not.toMatch(/\son[a-z]+=/);
      });

      it("keeps headings free of trailing periods and has no em dashes", () => {
        for (const match of html.matchAll(/<(h[1-6]|title)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
          expect((match[2] ?? "").replace(/<[^>]+>/g, "").trim()).not.toMatch(/\.$/);
        }
        expect(html).not.toContain("—");
      });

      it("gives every table a caption and header cells", () => {
        for (const table of html.match(/<table\b[\s\S]*?<\/table>/g) ?? []) {
          expect(table).toMatch(/<caption\b[^>]*>[^<]+<\/caption>/);
          expect(table).toContain('<th scope="col"');
          expect(table).toContain('<th scope="row"');
        }
      });
    });
  }

  it("covers what each document needs", () => {
    const terms = read("terms");
    for (const text of [
      "18 or older",
      "State of Florida",
      "Limitation of liability",
      "Disclaimers",
      "Changes to these terms",
      "Ending your use",
      "abuse@portifact.com",
      "license to host",
      "30 days",
      "six months",
    ]) {
      expect(terms, text).toContain(text);
    }
    const privacy = read("privacy");
    for (const text of [
      "privacy@portifact.com",
      "Cloudflare",
      "Cloudflare Email Service",
      "Google and GitHub",
      "How long we keep it",
      "Access logs (who opened an artifact and when)",
      "__Host-pf.session_token",
      "__Host-pf_terms",
    ]) {
      expect(privacy, text).toContain(text);
    }
    const aup = read("acceptable-use");
    for (const text of [
      "phishing",
      "malware",
      "mines cryptocurrency",
      "sexually explicit",
      "pirated",
      "impersonates",
      "abuse@portifact.com",
    ]) {
      expect(aup, text).toContain(text);
    }
  });
});

describe("legal links", () => {
  it("are in the landing page footer with the report form and the abuse address", () => {
    const html = read("index");
    expect(legalLinks(html)).toEqual([
      "/terms",
      "/privacy",
      "/acceptable-use",
      "https://app.portifact.com/report",
      "mailto:abuse@portifact.com",
    ]);
  });

  it("are in the footer of every auth page, on the site's origin", () => {
    for (const page of ["login", "device", "consent", "report"]) {
      expect(legalLinks(read(page)), page).toEqual([
        "https://portifact.com/",
        "https://portifact.com/terms",
        "https://portifact.com/privacy",
        "https://portifact.com/acceptable-use",
      ]);
    }
  });
});
