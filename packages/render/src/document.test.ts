import { createHash } from "node:crypto";
import { TOKENS_CSS } from "@portifact/ui/tokens-css";
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_STYLESHEET,
  REPORT_PATH,
  renderMarkdownDocument,
  renderTextDocument,
} from "./document.ts";
import {
  DIAGRAM_LOADER,
  DIAGRAM_LOADER_HASH,
  DIAGRAM_PATH,
  diagramFilePath,
  diagramFileVersion,
  documentPolicy,
} from "./policy.ts";
import { attr, byTag, document, text } from "./test-html.ts";
import { RENDERER_VERSION } from "./version.ts";

function head(html: string) {
  const root = document(html);
  const metas = byTag(root, "meta");
  const meta = (key: string, value: string) => metas.find((m) => attr(m, key) === value);
  return { root, meta };
}

describe("report link", () => {
  it("puts a footer with the artifact's report path under published documents", () => {
    for (const { html } of [
      renderMarkdownDocument("# Plan", { title: "t", reportLink: true }),
      renderTextDocument("plain", { title: "t", reportLink: true }),
    ]) {
      const root = document(html);
      const footers = byTag(root, "footer");
      expect(footers).toHaveLength(1);
      const footer = footers[0] ?? (root as never);
      // Outside main, so it is chrome, not content; ignored by annotation anchors and removable
      // in review mode.
      expect(byTag(byTag(root, "main")[0] ?? root, "footer")).toHaveLength(0);
      expect(attr(footer, "class")).toBe("pf-chrome");
      expect(attr(footer, "data-portifact-ignore")).toBe("");
      expect(attr(footer, "data-portifact-chrome")).toBe("");
      const links = byTag(footer, "a");
      expect(links.map((a) => [attr(a, "href"), attr(a, "rel"), text(a)])).toEqual([
        ["/__portifact/report", "nofollow", "Report this artifact"],
      ]);
      expect(REPORT_PATH).toBe("/__portifact/report");
      // Still no scripts or forms: the link is a plain navigation the document policy allows.
      expect(byTag(root, "script")).toHaveLength(0);
      expect(byTag(root, "form")).toHaveLength(0);
    }
  });

  it("leaves it out unless asked, as in the editor's preview", () => {
    expect(byTag(document(renderTextDocument("x", { title: "t" }).html), "footer")).toHaveLength(0);
    expect(
      byTag(document(renderMarkdownDocument("# x", { title: "t" }).html), "footer"),
    ).toHaveLength(0);
  });
});

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

  it("uses the same stylesheet text in every document, so a hash can allow it", () => {
    for (const { html } of [
      renderTextDocument("x", { title: "t" }),
      renderMarkdownDocument("# y", { title: "other" }),
    ]) {
      const styles = byTag(head(html).root, "style");
      expect(text(styles[0] ?? head(html).root)).toBe(DOCUMENT_STYLESHEET);
    }
  });

  it("forbids scripts, frames, forms and base changes through a policy in the document", () => {
    const { meta } = head(renderMarkdownDocument("x", { title: "t" }).html);
    const policy = meta("http-equiv", "Content-Security-Policy");
    expect(policy && attr(policy, "content")).toBe(documentPolicy());
    expect(documentPolicy()).toBe(
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

describe("diagrams", () => {
  const SOURCE = "# Plan\n\n```mermaid\nflowchart LR\n  A --> B\n```\n";

  it("loads the diagram script only in published documents with Mermaid blocks", () => {
    const scripts = (html: string) => byTag(document(html), "script");
    const live = renderMarkdownDocument(SOURCE, { title: "t", liveDiagrams: true });
    const [loader] = scripts(live.html);
    expect(scripts(live.html)).toHaveLength(1);
    expect(loader && text(loader)).toBe(DIAGRAM_LOADER);
    expect(loader?.attrs).toEqual([]);
    expect(live.diagrams).toBe(1);
    // The editor's preview runs no scripts; documents without diagrams need none.
    expect(scripts(renderMarkdownDocument(SOURCE, { title: "t" }).html)).toHaveLength(0);
    const none = renderMarkdownDocument("```ts\nlet a\n```", { title: "t", liveDiagrams: true });
    expect(scripts(none.html)).toHaveLength(0);
    expect(none.diagrams).toBe(0);
  });

  it("puts the loader after the content, outside main", () => {
    const { root } = head(renderMarkdownDocument(SOURCE, { title: "t", liveDiagrams: true }).html);
    expect(byTag(byTag(root, "main")[0] ?? root, "script")).toHaveLength(0);
    expect(byTag(byTag(root, "head")[0] ?? root, "script")).toHaveLength(0);
  });

  it("allows the loader by its hash, its script through strict-dynamic and blob: images", () => {
    const { meta } = head(renderMarkdownDocument(SOURCE, { title: "t", liveDiagrams: true }).html);
    const policy = meta("http-equiv", "Content-Security-Policy");
    expect(policy && attr(policy, "content")).toBe(documentPolicy({ diagrams: true }));
    expect(documentPolicy({ diagrams: true })).toBe(
      `default-src 'none'; img-src 'self' blob:; style-src 'unsafe-inline'; script-src ${DIAGRAM_LOADER_HASH} 'strict-dynamic'; base-uri 'none'; form-action 'none'`,
    );
    const quiet = head(renderMarkdownDocument(SOURCE, { title: "t" }).html);
    expect(
      attr(quiet.meta("http-equiv", "Content-Security-Policy") ?? (quiet.root as never), "content"),
    ).toBe(documentPolicy());
  });

  it("hashes the loader exactly", () => {
    const digest = createHash("sha256").update(DIAGRAM_LOADER, "utf8").digest("base64");
    expect(DIAGRAM_LOADER_HASH).toBe(`'sha256-${digest}'`);
    expect(DIAGRAM_LOADER).toContain(`"${DIAGRAM_PATH}"`);
    expect(DIAGRAM_PATH).toBe("/__portifact/diagrams.js");
  });
});

describe("diagram script paths", () => {
  it("put the build version in the file name and read it back from exactly that shape", () => {
    expect(diagramFilePath("0123456789abcdef")).toBe("/__portifact/diagrams.0123456789abcdef.js");
    expect(diagramFileVersion("/__portifact/diagrams.0123456789abcdef.js")).toBe(
      "0123456789abcdef",
    );
    for (const path of [
      DIAGRAM_PATH,
      "/__portifact/diagrams.0123456789ABCDEF.js",
      "/__portifact/diagrams.0123456789abcde.js",
      "/__portifact/diagrams.0123456789abcdef.js/x",
      "/x/__portifact/diagrams.0123456789abcdef.js",
    ]) {
      expect(diagramFileVersion(path)).toBeUndefined();
    }
  });
});

describe("document policy", () => {
  it("lists the loader's path and the current build's file for a known origin", () => {
    expect(
      documentPolicy({
        diagrams: true,
        origin: "https://a1.portifact.dev",
        diagramVersion: "0123456789abcdef",
        nonce: "n2",
      }),
    ).toContain(
      `script-src ${DIAGRAM_LOADER_HASH} https://a1.portifact.dev/__portifact/diagrams.js https://a1.portifact.dev/__portifact/diagrams.0123456789abcdef.js 'nonce-n2';`,
    );
    expect(documentPolicy({ diagrams: true, diagramVersion: "0123456789abcdef" })).not.toContain(
      "diagrams.0123456789abcdef.js",
    );
  });

  it("allows the diagram script at its exact URL when the origin is known", () => {
    expect(documentPolicy({ diagrams: true, origin: "https://a1.portifact.dev" })).toContain(
      `script-src ${DIAGRAM_LOADER_HASH} https://a1.portifact.dev/__portifact/diagrams.js;`,
    );
    expect(documentPolicy({ diagrams: true, origin: "https://a1.portifact.dev" })).not.toContain(
      "strict-dynamic",
    );
  });

  it("adds the bridge's nonce to the same script directive", () => {
    const policy = documentPolicy({
      diagrams: true,
      origin: "https://a1.portifact.dev",
      nonce: "n0",
    });
    expect(policy.match(/script-src/g)).toHaveLength(1);
    expect(policy).toContain("/__portifact/diagrams.js 'nonce-n0';");
    expect(documentPolicy({ nonce: "n1" })).toBe(
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-n1'; base-uri 'none'; form-action 'none'",
    );
  });

  it("combines remote images with diagrams", () => {
    expect(documentPolicy({ remoteImages: true, diagrams: true })).toContain(
      "img-src 'self' blob: https:;",
    );
  });
});
