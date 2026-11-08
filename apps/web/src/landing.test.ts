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
    expect(html).toMatch(/<html lang="en"[\s>]/);
    expect(html).toContain('href="#main"');
    expect(html).toContain('<main id="main">');
    expect(html).toMatch(/<nav aria-label="Main"[\s>]/);
    expect(html).toMatch(/role="status" aria-live="polite"/);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    for (const img of html.match(/<img\b[^>]*>/g) ?? []) expect(img).toMatch(/\balt="[^"]+"/);
  });

  it("keeps the agent prompt collapsed, with its copy button outside the disclosure", () => {
    const details = /<details\b([^>]*)>([\s\S]*?)<\/details>/g;
    const promptDisclosure = [...html.matchAll(details)].find((match) =>
      match[2]?.includes('id="agent-prompt"'),
    );
    expect(promptDisclosure).toBeDefined();
    expect(promptDisclosure?.[1]).not.toMatch(/\bopen\b/);
    expect(promptDisclosure?.[2]).toMatch(/<summary\b/);
    expect(promptDisclosure?.[2]).not.toContain('data-copy-target="agent-prompt"');
    expect(html).toContain('data-copy-target="agent-prompt"');
  });

  it("pairs every tab with a panel that points back to it", () => {
    const tabs = [...html.matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map((match) => match[0]);
    expect(tabs.length).toBeGreaterThanOrEqual(3);
    expect(tabs.filter((tab) => tab.includes('aria-selected="true"'))).toHaveLength(1);
    for (const tab of tabs) {
      const id = /\bid="([^"]+)"/.exec(tab)?.[1];
      const panel = /aria-controls="([^"]+)"/.exec(tab)?.[1];
      expect(html).toMatch(new RegExp(`role="tabpanel" id="${panel}" aria-labelledby="${id}"`));
    }
  });

  it("keeps headings and buttons free of trailing periods and em dashes", () => {
    for (const match of html.matchAll(/<(h[1-6]|button|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const text = (match[2] ?? "").replace(/<[^>]+>/g, "").trim();
      expect(text).not.toMatch(/\.$/);
    }
    expect(html).not.toContain("—");
  });

  it("gives the hero heading one stable, complete name and hides the animated line", () => {
    const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "";
    const spoken = /<span class="sr-only">([^<]+)<\/span>/.exec(h1)?.[1];
    const phrases = [...h1.matchAll(/<span data-typewriter-phrase\b[^>]*>([^<]+)</g)].map(
      (match) => match[1] ?? "",
    );
    const initial = /<span data-typewriter-text>([^<]*)<\/span>/.exec(h1)?.[1];

    expect(spoken).toBe(`Share what your agent built. ${phrases[0]}`);
    expect(h1.replace(/<span class="sr-only">[^<]*<\/span>/, "")).toMatch(
      /^\s*<span aria-hidden="true">[\s\S]*<\/span>\s*$/,
    );
    expect(phrases.length).toBeGreaterThanOrEqual(3);
    expect(initial).toBe(phrases[0]);
    for (const phrase of phrases) expect(phrase).not.toMatch(/[.—]$/);
    expect(h1).toMatch(/data-typewriter-caret class="[^"]*motion-reduce:hidden/);
  });

  it("lists the supported agents with monochrome icons and an honest note", () => {
    const strip = /<div id="agents"[\s\S]*?<\/ul>\s*<p\b[^>]*>([\s\S]*?)<\/p>/.exec(html);
    const items = [...(strip?.[0] ?? "").matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(
      (match) => match[1] ?? "",
    );
    expect(html).toMatch(/<ul\b[^>]*aria-labelledby="agents-title"/);
    expect(items.length).toBeGreaterThanOrEqual(8);
    for (const item of items) {
      expect(item).toMatch(/^<svg\b[^>]*fill="currentColor" aria-hidden="true"/);
      expect(item.replace(/<[^>]+>/g, "").trim()).not.toBe("");
    }
    const names = items.map((item) => item.replace(/<[^>]+>/g, "").trim());
    expect(names).toEqual(expect.arrayContaining(["Claude Code", "Codex", "Cursor", "Gemini CLI"]));
    expect(strip?.[1]).toMatch(/installer and the agent skill work/);
    expect(strip?.[1]).toMatch(/MCP is in development/);
    expect(strip?.[1]).toMatch(/OAuth/);
    expect(html).not.toMatch(/\b(?:fill|stroke)="#/);
  });

  it("links the star button in the top bar to the repository stargazers", () => {
    const header = /<header\b[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
    const star =
      /<a\s+href="https:\/\/github\.com\/leynier\/portifact\/stargazers"[\s\S]*?<\/a>/.exec(
        header,
      )?.[0];
    expect(star).toBeDefined();
    expect(star).toMatch(/<svg\b[^>]*aria-hidden="true"/);
    expect(star).toMatch(/>Star on GitHub</);
    expect(star).not.toMatch(/class="[^"]*\bhidden\b/);
  });

  it("labels every copy button with an existing target", () => {
    for (const match of html.matchAll(/data-copy-target="([^"]+)"/g)) {
      expect(html).toContain(`id="${match[1]}"`);
    }
  });
});
