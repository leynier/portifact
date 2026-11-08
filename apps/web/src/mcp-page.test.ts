import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../mcp-compatibility.html", import.meta.url), "utf8");
const matrix = readFileSync(new URL("../../../docs/mcp-compatibility.md", import.meta.url), "utf8");

function rowHeaders(source: string): string[] {
  return [...source.matchAll(/<th scope="row"[^>]*>([^<]+)<\/th>/g)].map((match) => match[1] ?? "");
}

describe("MCP compatibility page", () => {
  it("has the landmarks, one h1, its title and canonical address", () => {
    expect(html).toMatch(/<html lang="en"[\s>]/);
    expect(html).toContain('href="#main"');
    expect(html).toContain('<main id="main"');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain(">MCP compatibility</h1>");
    expect(html).toContain("<title>MCP compatibility: Portifact</title>");
    expect(html).toContain(
      '<link rel="canonical" href="https://portifact.com/mcp-compatibility" />',
    );
    for (const img of html.match(/<img\b[^>]*>/g) ?? []) expect(img).toMatch(/\balt="[^"]+"/);
  });

  it("loads no script, so it works without JavaScript under the strict CSP", () => {
    expect(html).not.toMatch(/<script\b/);
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\son[a-z]+=/);
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

  it("gives the matrix a caption and header cells", () => {
    const table = /<table\b[\s\S]*?<\/table>/.exec(html)?.[0] ?? "";
    expect(table).toMatch(/<caption\b[^>]*>[^<]+<\/caption>/);
    expect(table).toContain('<th scope="col"');
  });

  it("lists the clients and versions of docs/mcp-compatibility.md", () => {
    expect(rowHeaders(html)).toEqual(["Claude.ai", "Claude Code", "Codex CLI"]);
    for (const version of ["2.1.319", "0.167.0"]) {
      expect(html, version).toContain(version);
      expect(matrix, version).toContain(version);
    }
    const tested = /<time datetime="([\d-]+)">/.exec(html)?.[1];
    expect(tested).toBeDefined();
    expect(matrix).toContain(`Tested on ${tested}`);
  });

  it("keeps headings free of trailing periods and has no em dashes", () => {
    for (const match of html.matchAll(/<(h[1-6]|title)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      expect((match[2] ?? "").replace(/<[^>]+>/g, "").trim()).not.toMatch(/\.$/);
    }
    expect(html).not.toContain("—");
    expect(matrix).not.toContain("—");
  });

  it("links the legal pages from its footer", () => {
    const nav = /<nav aria-label="Legal"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
    const links = [...nav.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    expect(links).toEqual(["/terms", "/privacy", "/acceptable-use"]);
  });
});
