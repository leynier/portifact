import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_LABELS, renderMarkdown } from "./markdown.ts";
import { attr, byTag, elements, fragment, text } from "./test-html.ts";

const dom = (source: string, options?: Parameters<typeof renderMarkdown>[1]) =>
  fragment(renderMarkdown(source, options).html);

describe("CommonMark and GFM", () => {
  it("renders headings, emphasis, lists, quotes, code and rules as semantic HTML", () => {
    const root = dom(
      "# Title\n\nSome *em* and **strong** and `code`.\n\n> quoted\n\n1. one\n2. two\n\n- a\n- b\n\n---\n\n```ts\nconst x = 1;\n```\n",
    );
    expect(text(byTag(root, "h1")[0] ?? root)).toBe("Title");
    expect(byTag(root, "em")).toHaveLength(1);
    expect(byTag(root, "strong")).toHaveLength(1);
    expect(byTag(root, "blockquote")).toHaveLength(1);
    expect(byTag(root, "ol")[0]?.childNodes.filter((n) => n.nodeName === "li")).toHaveLength(2);
    expect(byTag(root, "ul")).toHaveLength(1);
    expect(byTag(root, "hr")).toHaveLength(1);
    const code = byTag(root, "pre").flatMap((pre) => byTag(pre, "code"));
    expect(code.map((c) => attr(c, "class"))).toEqual(["language-ts"]);
    expect(text(code[0] ?? root)).toBe("const x = 1;\n");
  });

  it("renders GFM tables with header cells and alignment classes instead of inline styles", () => {
    const root = dom("| Left | Center | Right |\n|:-----|:------:|------:|\n| 1 | 2 | 3 |\n");
    const headers = byTag(root, "th");
    expect(headers.map((th) => text(th))).toEqual(["Left", "Center", "Right"]);
    expect(byTag(byTag(root, "thead")[0] ?? root, "th")).toHaveLength(3);
    expect(byTag(root, "td").map((td) => attr(td, "class"))).toEqual([
      "pf-align-left",
      "pf-align-center",
      "pf-align-right",
    ]);
    expect(elements(root).some((element) => attr(element, "style") !== undefined)).toBe(false);
    const wrapper = byTag(root, "div")[0];
    expect(wrapper && attr(wrapper, "class")).toBe("pf-table");
    expect(wrapper && attr(wrapper, "tabindex")).toBe("0");
  });

  it("keeps a cell without alignment free of classes", () => {
    const root = dom("| a |\n|---|\n| b |\n");
    expect(byTag(root, "td").map((td) => attr(td, "class"))).toEqual([undefined]);
  });

  it("renders strikethrough", () => {
    expect(text(byTag(dom("~~gone~~"), "s")[0] ?? fragment(""))).toBe("gone");
  });

  it("renders task lists as disabled checkboxes and marks their list", () => {
    const root = dom("- [ ] todo\n- [x] done\n- [X] also\n- plain\n- [y] not a task\n");
    const boxes = byTag(root, "input");
    expect(boxes).toHaveLength(3);
    expect(boxes.every((box) => attr(box, "type") === "checkbox")).toBe(true);
    expect(boxes.every((box) => attr(box, "disabled") !== undefined)).toBe(true);
    expect(boxes.map((box) => attr(box, "checked") !== undefined)).toEqual([false, true, true]);
    expect(attr(byTag(root, "ul")[0] ?? (root as never), "class")).toBe("contains-task-list");
    const items = byTag(root, "li");
    expect(items.map((li) => attr(li, "class"))).toEqual([
      "task-list-item",
      "task-list-item",
      "task-list-item",
      undefined,
      undefined,
    ]);
    expect(items.map((li) => text(li).trim())).toEqual([
      "todo",
      "done",
      "also",
      "plain",
      "[y] not a task",
    ]);
  });

  it("marks only the innermost list of a nested task item", () => {
    const root = dom("- outer\n  - [x] inner\n");
    const lists = byTag(root, "ul");
    expect(lists.map((ul) => attr(ul, "class"))).toEqual([undefined, "contains-task-list"]);
  });

  it("ignores a task marker that does not start the item", () => {
    expect(byTag(dom("- a [x] b\n- `[x]` c\n"), "input")).toHaveLength(0);
  });

  it("autolinks www hosts, URLs and emails like GFM, but not bare domains", () => {
    const links = byTag(
      dom("Visit www.example.com, https://example.org/a?b=1, me@example.com or example.net."),
      "a",
    );
    expect(links.map((a) => attr(a, "href"))).toEqual([
      "http://www.example.com",
      "https://example.org/a?b=1",
      "mailto:me@example.com",
    ]);
  });

  it("renders footnotes with back references and accessible labels", () => {
    const root = dom("One[^a] two[^b] again[^a].\n\n[^a]: First.\n[^b]: Second.\n");
    const refs = byTag(root, "sup").flatMap((sup) => byTag(sup, "a"));
    expect(refs.map((a) => [attr(a, "href"), attr(a, "id"), text(a)])).toEqual([
      ["#fn:1", "fnref:1", "1"],
      ["#fn:2", "fnref:2", "2"],
      ["#fn:1", "fnref:1:1", "1"],
    ]);
    const section = byTag(root, "section")[0];
    expect(section && attr(section, "aria-label")).toBe("Footnotes");
    const notes = byTag(section ?? root, "li");
    expect(notes.map((li) => attr(li, "id"))).toEqual(["fn:1", "fn:2"]);
    const back = byTag(section ?? root, "a");
    expect(back.map((a) => [attr(a, "href"), attr(a, "aria-label")])).toEqual([
      ["#fnref:1", "Back to reference 1"],
      ["#fnref:1:1", "Back to reference 1"],
      ["#fnref:2", "Back to reference 2"],
    ]);
  });

  it("uses translated labels and escapes them", () => {
    const root = dom("x[^1]\n\n[^1]: y\n", {
      labels: { footnotes: 'Notas "<b>"', backToReference: (n) => `Volver a la referencia ${n}` },
    });
    expect(attr(byTag(root, "section")[0] ?? (root as never), "aria-label")).toBe('Notas "<b>"');
    expect(byTag(root, "b")).toHaveLength(0);
    const back = byTag(root, "a").find((a) => attr(a, "class") === "footnote-backref");
    expect(back && attr(back, "aria-label")).toBe("Volver a la referencia 1");
    expect(DEFAULT_LABELS.backToReference(3)).toBe("Back to reference 3");
  });

  it("keeps the author's alt text on images", () => {
    const image = byTag(dom('![A chart of usage](chart.png "Usage")'), "img")[0];
    expect(image && [attr(image, "src"), attr(image, "alt"), attr(image, "title")]).toEqual([
      "chart.png",
      "A chart of usage",
      "Usage",
    ]);
  });
});

describe("heading ids", () => {
  it("are GitHub-style slugs, so existing fragment links keep working", () => {
    const { headings, html } = renderMarkdown(
      "# Getting Started\n## API `v2` *reference*\n### Ünïcödé Títle\n[jump](#getting-started)",
    );
    expect(headings).toEqual([
      { id: "getting-started", level: 1, text: "Getting Started" },
      { id: "api-v2-reference", level: 2, text: "API v2 reference" },
      { id: "ünïcödé-títle", level: 3, text: "Ünïcödé Títle" },
    ]);
    expect(html).toContain('href="#getting-started"');
  });

  it("are unique when headings repeat", () => {
    const { headings } = renderMarkdown("# Notes\n# Notes\n# Notes");
    expect(headings.map((h) => h.id)).toEqual(["notes", "notes-1", "notes-2"]);
  });

  it("fall back to a neutral word when a heading has nothing to slug", () => {
    const { headings } = renderMarkdown("# !!!\n#\n# ???");
    expect(headings.map((h) => h.id)).toEqual(["section", "section-1", "section-2"]);
  });

  it("include alt text of images inside the heading", () => {
    expect(renderMarkdown("# ![Logo](l.png) Home").headings[0]?.id).toBe("logo-home");
  });

  it("never collide with footnote ids", () => {
    const { headings, html } = renderMarkdown("# fn:1\n# fnref 1\n\nx[^1]\n\n[^1]: y");
    const ids = elements(fragment(html)).flatMap((e) => attr(e, "id") ?? []);
    expect(new Set(ids).size).toBe(ids.length);
    expect(headings.map((h) => h.id)).toEqual(["fn1", "fnref-1"]);
  });

  it("are unique across any set of headings", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 12 }), { maxLength: 20 }), (titles) => {
        const source = titles.map((t) => `# ${t.replace(/[\r\n]/g, " ")}`).join("\n");
        const ids = renderMarkdown(source).headings.map((h) => h.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every((id) => id.length > 0)).toBe(true);
      }),
    );
  });
});

describe("block map", () => {
  it("gives every rendered block a stable id and its source range", () => {
    const source = "# Title\n\nFirst paragraph\nstill first.\n\n- item\n\n> quote\n";
    const { html, blocks } = renderMarkdown(source);
    expect(blocks.map((b) => [b.id, b.tag, b.startLine, b.endLine])).toEqual([
      ["b1", "h1", 1, 1],
      ["b2", "p", 3, 4],
      ["b3", "ul", 6, 7],
      ["b4", "li", 6, 7],
      ["b5", "blockquote", 8, 8],
      ["b6", "p", 8, 8],
    ]);
    expect(blocks.map((b) => source.slice(b.start, b.end))).toEqual([
      "# Title",
      "First paragraph\nstill first.",
      "- item\n",
      "- item\n",
      "> quote",
      "> quote",
    ]);
    const marked = elements(fragment(html)).flatMap((e) => attr(e, "data-pf-block") ?? []);
    expect(marked).toEqual(blocks.map((b) => b.id));
  });

  it("skips paragraphs that tight lists do not render", () => {
    const { blocks } = renderMarkdown("- a\n- b\n");
    expect(blocks.map((b) => b.tag)).toEqual(["ul", "li", "li"]);
  });

  it("maps code, tables and rows", () => {
    const source = "```\ncode\n```\n\n    indented\n\n| h |\n|---|\n| c |";
    const { blocks } = renderMarkdown(source);
    expect(blocks.map((b) => [b.tag, source.slice(b.start, b.end)])).toEqual([
      ["code", "```\ncode\n```"],
      ["code", "    indented"],
      ["table", "| h |\n|---|\n| c |"],
      ["tr", "| h |"],
      ["tr", "| c |"],
    ]);
  });

  it("reports offsets into the original source with CRLF and CR line breaks", () => {
    for (const newline of ["\r\n", "\r"]) {
      const source = ["# One", "", "two", "", "three"].join(newline);
      const { blocks } = renderMarkdown(source);
      expect(blocks.map((b) => source.slice(b.start, b.end))).toEqual(["# One", "two", "three"]);
      expect(blocks.map((b) => b.startLine)).toEqual([1, 3, 5]);
    }
  });

  it("counts offsets in UTF-16 code units", () => {
    const source = "😀 emoji\n\nnext";
    const next = renderMarkdown(source).blocks[1];
    expect(next?.start).toBe(source.indexOf("next"));
    expect(next?.start).toBe(10);
  });

  it("keeps every range inside the source for any input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (source) => {
        for (const block of renderMarkdown(source).blocks) {
          expect(block.start).toBeGreaterThanOrEqual(0);
          expect(block.end).toBeGreaterThanOrEqual(block.start);
          expect(block.end).toBeLessThanOrEqual(source.length);
          expect(block.endLine).toBeGreaterThanOrEqual(block.startLine);
        }
      }),
    );
  });
});

describe("determinism", () => {
  it("renders the same source to the same output every time", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (source) => {
        expect(renderMarkdown(source)).toEqual(renderMarkdown(source));
      }),
    );
  });

  it("does not leak state such as slugs or footnotes between renders", () => {
    const first = renderMarkdown("# A\n\nx[^1]\n\n[^1]: y");
    renderMarkdown("# A\n# A\n\nz[^2]\n\n[^2]: w");
    expect(renderMarkdown("# A\n\nx[^1]\n\n[^1]: y")).toEqual(first);
  });
});
