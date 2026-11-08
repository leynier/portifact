import { TOKENS_CSS } from "@portifact/ui/tokens-css";
import { describe, expect, it } from "vitest";
import { documentPolicy, renderMarkdownDocument, renderTextDocument } from "./document.ts";
import { attr, byTag, document, text } from "./test-html.ts";
import { RENDERER_VERSION } from "./version.ts";

function head(html: string) {
  const root = document(html);
  const metas = byTag(root, "meta");
  const meta = (key: string, value: string) => metas.find((m) => attr(m, key) === value);
  return { root, meta };
}

describe("document wrapper", () => {
  it("is a complete, accessible document with the content in a main landmark", () => {
    const { html } = renderMarkdownDocument("# Plan\n\nBody", { title: "My plan", lang: "es" });
    expect(html.startsWith("<!doctype html>\n")).toBe(true);
    const { root, meta } = head(html);
    expect(attr(byTag(root, "html")[0] ?? (root as never), "lang")).toBe("es");
    expect(text(byTag(root, "title")[0] ?? root)).toBe("My plan");
    expect(meta("charset", "utf-8")).toBeDefined();
    expect(meta("name", "viewport")).toBeDefined();
    const main = byTag(root, "main");
    expect(main).toHaveLength(1);
    expect(attr(main[0] ?? (root as never), "class")).toBe("pf-document pf-markdown");
    expect(byTag(main[0] ?? root, "h1").map((h) => text(h))).toEqual(["Plan"]);
  });

  it("defaults the language to English and rejects malformed language tags", () => {
    const { root } = head(renderTextDocument("x", { title: "t" }).html);
    expect(attr(byTag(root, "html")[0] ?? (root as never), "lang")).toBe("en");
    expect(() => renderTextDocument("x", { title: "t", lang: 'en" onload="x' })).toThrow(
      RangeError,
    );
    expect(() => renderTextDocument("x", { title: "t", lang: "pt-BR" })).not.toThrow();
  });

  it("escapes the title", () => {
    const { html } = renderTextDocument("x", { title: "</title><script>alert(1)</script>" });
    const { root } = head(html);
    expect(byTag(root, "script")).toHaveLength(0);
    expect(text(byTag(root, "title")[0] ?? root)).toBe("</title><script>alert(1)</script>");
  });

  it("inlines the design tokens and viewer styles, and nothing else", () => {
    const { html } = renderTextDocument("x", { title: "t" });
    const { root } = head(html);
    const styles = byTag(root, "style");
    expect(styles).toHaveLength(1);
    const css = text(styles[0] ?? root);
    expect(css).toContain(TOKENS_CSS);
    expect(css).toContain(".pf-text");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(byTag(root, "link")).toHaveLength(0);
    expect(byTag(root, "script")).toHaveLength(0);
  });

  it("forbids scripts, frames, forms and base changes through a policy in the document", () => {
    const { meta } = head(renderMarkdownDocument("x", { title: "t" }).html);
    const policy = meta("http-equiv", "Content-Security-Policy");
    expect(policy && attr(policy, "content")).toBe(documentPolicy(false));
    expect(documentPolicy(false)).toBe(
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    expect(meta("name", "referrer")).toBeDefined();
    expect(attr(meta("name", "referrer") ?? (policy as never), "content")).toBe("no-referrer");
  });

  it("allows remote images in the policy only when the document opts in", () => {
    const source = "![x](https://cdn.example/x.png)";
    const off = head(renderMarkdownDocument(source, { title: "t" }).html);
    const on = head(renderMarkdownDocument(source, { title: "t", remoteImages: true }).html);
    const content = (h: typeof off) =>
      attr(h.meta("http-equiv", "Content-Security-Policy") ?? (h.root as never), "content");
    expect(content(off)).toContain("img-src 'self';");
    expect(content(on)).toContain("img-src 'self' https:;");
    expect(byTag(off.root, "img")).toHaveLength(0);
    expect(byTag(on.root, "img")).toHaveLength(1);
  });

  it("returns the renderer version, the block map and the headings with a Markdown document", () => {
    const result = renderMarkdownDocument("# A\n\ntext", { title: "t" });
    expect(result.rendererVersion).toBe(RENDERER_VERSION);
    expect(result.blocks.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(result.headings).toEqual([{ id: "a", level: 1, text: "A" }]);
    expect(renderTextDocument("x", { title: "t" }).rendererVersion).toBe(RENDERER_VERSION);
  });

  it("wraps text in the text viewer", () => {
    const { root } = head(renderTextDocument("<b>hi</b>", { title: "t" }).html);
    const main = byTag(root, "main")[0];
    expect(main && attr(main, "class")).toBe("pf-document");
    expect(attr(byTag(root, "pre")[0] ?? (root as never), "class")).toBe("pf-text");
    expect(byTag(root, "b")).toHaveLength(0);
    expect(text(byTag(root, "pre")[0] ?? root)).toBe("<b>hi</b>");
  });
});
