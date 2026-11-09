import { existsSync, readFileSync } from "node:fs";
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
    expect(strip?.[1]).toMatch(/CLI and the agent skill work/);
    expect(strip?.[1]).toMatch(/OAuth/);
    expect(strip?.[1]).toContain('href="/mcp-compatibility"');
    expect(strip?.[1]).not.toMatch(/in development/i);
    expect(html).not.toMatch(/\b(?:fill|stroke)="#/);
  });

  it("offers a visible sign-in link to the app in the top bar, on every screen size", () => {
    const header = /<header\b[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
    const signIn = /<a\s+href="https:\/\/app\.portifact\.com\/"[\s\S]*?<\/a\s*>/.exec(header)?.[0];
    expect(signIn).toBeDefined();
    expect(signIn?.replace(/<[^>]+>/g, "").trim()).toBe("Sign in");
    expect(signIn).not.toMatch(/class="[^"]*\b(?:hidden|sr-only)\b/);
    expect(header.indexOf("app.portifact.com/")).toBeLessThan(header.indexOf('href="#install"'));
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

  it("describes shipped features as available and keeps only unshipped ones as planned", () => {
    expect(html).not.toMatch(
      /in development|upcoming releases|planned interface|arrive in the next/i,
    );
    const status = /<div id="status"[\s\S]*?<\/ul>/.exec(html)?.[0] ?? "";
    const rows = [...status.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((match) =>
      (match[1] ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    const available = rows.filter((row) => row.endsWith("Available"));
    const planned = rows.filter((row) => row.endsWith("Planned"));
    expect(available.length + planned.length).toBe(rows.length);
    for (const feature of [
      "Publish HTML sites, Markdown and text",
      "Access control",
      "Archive and restore",
      "Annotations and review",
      "MCP server",
      "Web dashboard",
    ]) {
      expect(available).toContain(`${feature} Available`);
    }
    expect(available).toContain("Access logs for your artifacts Available");
    expect(planned).toEqual([]);
    const pills = [
      ...html.matchAll(/role="tabpanel"[\s\S]*?<p\b[^>]*rounded-full[^>]*>([\s\S]*?)<\/p>/g),
    ];
    expect(pills).toHaveLength(3);
    for (const pill of pills)
      expect((pill[1] ?? "").replace(/<[^>]+>/g, "").trim()).toBe("Available");
  });

  it("explains how to connect the MCP server and links the compatibility page", () => {
    const connect = /<div id="connect-mcp"[\s\S]*?<\/div>\s*<div\b/.exec(html)?.[0] ?? "";
    expect(connect).toContain('<code id="mcp-url">https://app.portifact.com/mcp</code>');
    expect(connect).toContain('data-copy-target="mcp-url"');
    expect(connect).toMatch(/sign in with your Portifact account/);
    expect(connect).toContain('href="/mcp-compatibility"');
    const mcpPanel = /<div role="tabpanel" id="panel-mcp"[\s\S]*?<!-- Dashboard panel -->/.exec(
      html,
    )?.[0];
    expect(mcpPanel).toContain("https://app.portifact.com/mcp");
    expect(mcpPanel).toContain('href="/mcp-compatibility"');
  });

  it("points to the dashboard sign-in outside the top bar too", () => {
    const install = /<section id="install"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(install).toMatch(
      /<a href="https:\/\/app\.portifact\.com\/"[^>]*>Sign in to the dashboard<\/a>/,
    );
    const cta =
      /<section\b[^>]*aria-labelledby="cta-title"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(cta).toContain('href="https://app.portifact.com/"');
  });

  it("labels every copy button with an existing target", () => {
    for (const match of html.matchAll(/data-copy-target="([^"]+)"/g)) {
      expect(html).toContain(`id="${match[1]}"`);
    }
  });

  it("shows the product as real screenshots, light and dark, at 1x and 2x, without layout shift", () => {
    const pictures = [...html.matchAll(/<picture\b[^>]*>([\s\S]*?)<\/picture>/g)]
      .map((match) => match[1] ?? "")
      .filter((inner) => inner.includes("./src/assets/landing/"));
    expect(pictures).toHaveLength(3);
    for (const [index, inner] of pictures.entries()) {
      const img = /<img\b[^>]*>/.exec(inner)?.[0] ?? "";
      const dark = /<source\b[^>]*>/.exec(inner)?.[0] ?? "";
      expect(dark).toContain('media="(prefers-color-scheme: dark)"');
      expect(img).toMatch(/\balt="[^"]{80,}"/);
      expect(img).toContain('decoding="async"');
      // Only the hero, above the fold, loads at once.
      expect(img).toContain(index === 0 ? 'fetchpriority="high"' : 'loading="lazy"');
      const width = Number(/\bwidth="(\d+)"/.exec(img)?.[1]);
      const height = Number(/\bheight="(\d+)"/.exec(img)?.[1]);
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      for (const tag of [img, dark]) {
        const candidates = (/\bsrcset="([^"]+)"/.exec(tag)?.[1] ?? "")
          .split(",")
          .map((c) => c.trim());
        expect(candidates).toHaveLength(2);
        expect(tag).toMatch(/\bsizes="[^"]+"/);
        for (const [scale, candidate] of candidates.entries()) {
          const [path, descriptor] = candidate.split(/\s+/);
          const file = new URL(`../${path}`, import.meta.url);
          expect(existsSync(file), path).toBe(true);
          expect(descriptor).toBe(`${width * (scale + 1)}w`);
          expect(webpSize(readFileSync(file))).toEqual({
            width: width * (scale + 1),
            height: height * (scale + 1),
          });
        }
      }
    }
  });

  it("fills every terminal transcript from the shots run, as production shows it", () => {
    const regions = [...html.matchAll(/<!-- shots:([a-z-]+) -->([\s\S]*?)<!-- \/shots:\1 -->/g)];
    expect(regions.map((match) => match[1])).toEqual([
      "hero-terminal",
      "cli-terminal",
      "agent-session",
      "review-terminal",
    ]);
    for (const [, , content = ""] of regions) {
      expect(content.trim()).not.toBe("");
      expect(content).not.toMatch(/\.test\b|pf-shots|\/tmp\/|Using the Portifact server/);
    }
    const cli = regions[1]?.[2] ?? "";
    expect(cli).toContain("portifact publish ./prototype");
    expect(cli).toContain("portifact access add");
    expect(cli).toContain("portifact annotations export");
    expect(regions[2]?.[2]).toMatch(/publish_document[\s\S]*list_annotations/);
  });
});

/** Width and height from a WebP file's header (lossy, lossless or extended). */
function webpSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WEBP");
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  expect(chunk).toBe("VP8X");
  return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
}
