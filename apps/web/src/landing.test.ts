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

  it("labels every copy button with an existing target", () => {
    for (const match of html.matchAll(/data-copy-target="([^"]+)"/g)) {
      expect(html).toContain(`id="${match[1]}"`);
    }
  });
});
