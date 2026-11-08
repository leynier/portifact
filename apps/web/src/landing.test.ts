import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const readme = readFileSync(new URL("../../../readme.md", import.meta.url), "utf8");

function decode(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

describe("landing page", () => {
  it("shows the same agent install prompt as the readme", () => {
    const fromHtml = /<code id="agent-prompt">([\s\S]*?)<\/code>/.exec(html)?.[1];
    const fromReadme = /## Install it with your agent[\s\S]*?```text\n([\s\S]*?)\n```/.exec(
      readme,
    )?.[1];
    expect(fromHtml).toBeDefined();
    expect(fromReadme).toBeDefined();
    expect(decode(fromHtml ?? "")).toBe(fromReadme);
  });

  it("advertises the installers that the redirects serve", () => {
    expect(html).toContain("curl -fsSL https://portifact.com/install | bash");
    expect(html).toContain("irm https://portifact.com/install.ps1 | iex");
  });

  it("has the landmarks and labels assistive technology relies on", () => {
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toContain('href="#main"');
    expect(html).toContain('<main id="main">');
    expect(html).toMatch(/<nav aria-label="Main">/);
    expect(html).toMatch(/role="status" aria-live="polite"/);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    for (const img of html.match(/<img\b[^>]*>/g) ?? []) expect(img).toMatch(/\balt="[^"]+"/);
  });

  it("labels every copy button with an existing target", () => {
    for (const match of html.matchAll(/data-copy-target="([^"]+)"/g)) {
      expect(html).toContain(`id="${match[1]}"`);
    }
  });
});
