import { AnnotationTarget, TextAnchor } from "@portifact/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AnchorDocument } from "./document.ts";
import type { DomRange } from "./dom.ts";
import { at, page, rangeText } from "./test-helpers.ts";

function textAnchor(doc: AnchorDocument, range: DomRange) {
  const result = doc.createTextAnchor(range);
  if (!result.ok) throw new Error(`expected an anchor: ${result.message}`);
  return result.value;
}

describe("AnchorDocument text", () => {
  it("builds the normalized text from visible text only, separating blocks", () => {
    const { body } = page(`
      <h1>Title</h1>
      <p>Hello <b>wor</b>ld</p>
      <script>secret()</script><style>p{}</style><noscript>no</noscript>
      <textarea>form value</textarea><select><option>choice</option></select>
      <div hidden>hidden</div><div data-portifact-ignore>review ui</div>
      <ul><li>alpha</li><li>beta</li></ul>
      <table><tr><td>a1</td><td>b1</td></tr></table>
      <p>line<br>break</p><!-- comment --><div>inline<p>para</p>tail</div>`);
    expect(new AnchorDocument(body).text.value).toBe(
      "Title Hello world alpha beta a1 b1 line break inline para tail",
    );
  });

  it("anchors a selection across inline nodes and resolves it to the same text", () => {
    const { document, body } = page("<p>Say Hello <b>wor</b>ld today</p>");
    const doc = new AnchorDocument(body);
    const anchor = textAnchor(doc, { start: at(body, "Hello"), end: at(body, "ld", 2) });
    expect(anchor.quote).toEqual({ exact: "Hello world", prefix: "Say ", suffix: " today" });
    expect(anchor.position).toEqual({ start: 4, end: 15 });
    const resolved = doc.resolveText(anchor);
    expect(resolved.confidence).toBe("exact");
    if (resolved.confidence === "orphaned") return;
    expect(rangeText(document, resolved.range)).toBe("Hello world");
  });

  it("anchors across blocks, list items, table cells and code", () => {
    const { document, body } = page(`
      <p>one</p><p>two</p>
      <ol><li>first item</li><li>second item</li></ol>
      <table><tr><th>Name</th><td>Value</td></tr></table>
      <pre><code>const  x =
  1;</code></pre>`);
    const doc = new AnchorDocument(body);
    const cases: Array<[DomRange, string]> = [
      [{ start: at(body, "one"), end: at(body, "two", 3) }, "one two"],
      [{ start: at(body, "first", 6), end: at(body, "second", 6) }, "item second"],
      [{ start: at(body, "Name"), end: at(body, "Value", 5) }, "Name Value"],
      [{ start: at(body, "const"), end: at(body, "1;", 2) }, "const x = 1;"],
    ];
    for (const [range, quote] of cases) {
      const anchor = textAnchor(doc, range);
      expect(anchor.quote.exact).toBe(quote);
      const resolved = doc.resolveText(anchor);
      if (resolved.confidence === "orphaned") throw new Error("expected a match");
      expect(resolved.confidence).toBe("exact");
      // The DOM's own Range text has no separator between blocks; ours adds one.
      expect(rangeText(document, resolved.range).replace(/ /g, "")).toBe(quote.replace(/ /g, ""));
      expect(textAnchor(doc, resolved.range).quote.exact).toBe(quote);
    }
  });

  it("measures positions in code points of NFC text, from UTF-16 DOM offsets", () => {
    const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
    const { document, body } = page(`<p>cafe\u0301 ${family} \u{1F600} done</p>`);
    const doc = new AnchorDocument(body);
    const start = at(body, family);
    const anchor = textAnchor(doc, {
      start,
      end: { node: start.node, offset: start.offset + family.length },
    });
    expect(anchor.quote.exact).toBe(family);
    expect(anchor.quote.prefix).toBe("caf\u00e9 ");
    expect(anchor.position).toEqual({ start: 5, end: 10 });
    const resolved = doc.resolveText(anchor);
    if (resolved.confidence === "orphaned") throw new Error("expected a match");
    expect(rangeText(document, resolved.range)).toBe(family);
  });

  it("accepts element boundary points and backward ranges", () => {
    const { body } = page("<p><b>bold</b> and <i>italic</i></p>");
    const doc = new AnchorDocument(body);
    const p = body.childNodes[0] as never as AnchorDocument["root"];
    const anchor = textAnchor(doc, { start: { node: p, offset: 3 }, end: { node: p, offset: 0 } });
    expect(anchor.quote.exact).toBe("bold and italic");
    const tail = textAnchor(doc, { start: { node: p, offset: 2 }, end: { node: body, offset: 1 } });
    expect(tail.quote.exact).toBe("italic");
  });

  it("refuses a collapsed selection, even inside a surrogate pair", () => {
    const { body } = page("<p>a \u{1F600} b</p>");
    const doc = new AnchorDocument(body);
    const inside = at(body, "\u{1F600}", 1);
    expect(doc.createTextAnchor({ start: inside, end: inside })).toMatchObject({
      ok: false,
      reason: "empty_selection",
    });
    const half = textAnchor(doc, { start: inside, end: at(body, " b", 2) });
    expect(half.quote.exact).toBe("\u{1F600} b");
  });

  it("clamps a text offset past the end of its node", () => {
    const { body } = page("<p>abc</p><p>def</p>");
    const doc = new AnchorDocument(body);
    const anchor = textAnchor(doc, {
      start: at(body, "abc", 1),
      end: { ...at(body, "abc"), offset: 99 },
    });
    expect(anchor.quote.exact).toBe("bc");
  });

  it("maps points inside skipped elements to their boundary", () => {
    const { body } = page("<p>before</p><script>var hidden = 1;</script><p>after</p>");
    const doc = new AnchorDocument(body);
    const anchor = textAnchor(doc, { start: at(body, "hidden"), end: at(body, "after", 5) });
    expect(anchor.quote.exact).toBe("after");
  });

  it("refuses points outside the root, invalid offsets and empty selections", () => {
    const { document, body } = page("<p>text and  more</p>");
    const doc = new AnchorDocument(body);
    const outside = { node: document.head, offset: 0 };
    expect(doc.createTextAnchor({ start: outside, end: at(body, "text", 4) })).toMatchObject({
      ok: false,
      reason: "outside_root",
    });
    expect(
      doc.createTextAnchor({
        start: { ...at(body, "text"), offset: -1 },
        end: at(body, "text", 4),
      }),
    ).toMatchObject({
      ok: false,
      reason: "invalid_range",
    });
    expect(
      doc.createTextAnchor({ start: at(body, "text"), end: { ...at(body, "text"), offset: 1.5 } }),
    ).toMatchObject({
      ok: false,
      reason: "invalid_range",
    });
    expect(doc.createTextAnchor({ start: at(body, "  "), end: at(body, "  ", 2) })).toMatchObject({
      ok: false,
      reason: "empty_selection",
    });
  });

  it("adds a DOM hint naming the element around the selection, accepted by the contract", () => {
    const { body } = page('<main><section id="intro"><p>Some <em>words</em></p></section></main>');
    const anchor = textAnchor(new AnchorDocument(body), {
      start: at(body, "words"),
      end: at(body, "words", 5),
    });
    expect(anchor.domHint).toBe("#intro > p > em");
    const target = { schema: 1, path: "index.html", anchor };
    expect(AnnotationTarget.safeParse(target).success).toBe(true);
    const plain = page("text directly in body");
    const bare = textAnchor(new AnchorDocument(plain.body), {
      start: at(plain.body, "text"),
      end: at(plain.body, "text", 4),
    });
    expect(bare.domHint).toBeUndefined();
  });

  it("uses the DOM hint to break a tie, and only a hint that finds one element", () => {
    const html = '<section id="one"><p>dup</p></section><section id="two"><p>dup</p></section>';
    const { document, body } = page(html);
    const doc = new AnchorDocument(body);
    const base = {
      kind: "text" as const,
      quote: { exact: "dup", prefix: "", suffix: "" },
      position: { start: 0, end: 3 },
    };
    const two = TextAnchor.parse({ ...base, position: { start: 1, end: 4 }, domHint: "#two" });
    const resolved = doc.resolveText(two);
    if (resolved.confidence === "orphaned") throw new Error("expected a match");
    expect(resolved).toMatchObject({ confidence: "fuzzy", start: 4, end: 7 });
    expect(rangeText(document, resolved.range)).toBe("dup");
    const one = doc.resolveText({ ...two, domHint: "#one" });
    expect(one).toMatchObject({ confidence: "fuzzy", start: 0, end: 3 });
    expect(doc.resolveText({ ...two, domHint: "section" })).toEqual({
      confidence: "orphaned",
      reason: "ambiguous",
    });
    expect(doc.resolveText({ ...two, domHint: "#none" })).toEqual({
      confidence: "orphaned",
      reason: "ambiguous",
    });
    expect(doc.resolveText({ ...base, position: { start: 1, end: 4 } })).toEqual({
      confidence: "orphaned",
      reason: "ambiguous",
    });
  });

  it("follows a quote into a new version of the page and orphans one that is gone", () => {
    const original = page("<p>Intro</p><p>The important sentence.</p>");
    const anchor = textAnchor(new AnchorDocument(original.body), {
      start: at(original.body, "important"),
      end: at(original.body, "important", 9),
    });
    const next = page("<p>A new paragraph first.</p><p>Intro</p><p>The important sentence.</p>");
    const moved = new AnchorDocument(next.body).resolveText(anchor);
    if (moved.confidence === "orphaned") throw new Error("expected a match");
    expect(moved.confidence).toBe("fuzzy");
    expect(rangeText(next.document, moved.range)).toBe("important");
    const gone = page("<p>Intro</p><p>Rewritten.</p>");
    expect(new AnchorDocument(gone.body).resolveText(anchor)).toEqual({
      confidence: "orphaned",
      reason: "not_found",
    });
  });

  it("resolves any selection it anchored back to a range with the same text", () => {
    const inline = fc.oneof(
      fc
        .string({ unit: "grapheme", minLength: 1, maxLength: 12 })
        .map((value) => ({ tag: "", value })),
      fc.record({
        tag: fc.constantFrom("b", "em", "code", "span"),
        value: fc.string({ minLength: 1, maxLength: 8 }),
      }),
    );
    const block = fc.record({
      tag: fc.constantFrom("p", "li", "td", "h2", "div"),
      inlines: fc.array(inline, { minLength: 1, maxLength: 4 }),
    });
    const escapeHtml = (value: string) =>
      value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    fc.assert(
      fc.property(
        fc.array(block, { minLength: 1, maxLength: 5 }),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        (blocks, a, b, c, d) => {
          const html = blocks
            .map(({ tag, inlines }) => {
              const inner = inlines
                .map(({ tag: t, value }) =>
                  t ? `<${t}>${escapeHtml(value)}</${t}>` : escapeHtml(value),
                )
                .join("");
              return `<${tag}>${inner}</${tag}>`;
            })
            .join("");
          const { document, body } = page(html);
          const nodes = (function collect(node: typeof body): (typeof body)[] {
            return Array.from(node.childNodes).flatMap((child) =>
              child.nodeType === 3 ? [child as typeof body] : collect(child as typeof body),
            );
          })(body);
          fc.pre(nodes.length > 0);
          const point = (i: number, o: number) => {
            const node = nodes[i % nodes.length] as typeof body;
            const length = (node as unknown as { data: string }).data.length;
            return { node, offset: o % (length + 1) };
          };
          const range = { start: point(a, b), end: point(c, d) };
          const doc = new AnchorDocument(body);
          const result = doc.createTextAnchor(range);
          if (!result.ok) {
            expect(result.reason).toBe("empty_selection");
            return;
          }
          expect(TextAnchor.safeParse(result.value).success).toBe(true);
          const resolved = doc.resolveText(result.value);
          if (resolved.confidence === "orphaned") throw new Error("expected a match");
          expect(resolved.confidence).toBe("exact");
          expect(rangeText(document, resolved.range).replace(/ /g, "")).toBe(
            result.value.quote.exact.replace(/ /g, ""),
          );
        },
      ),
      { numRuns: 150 },
    );
  });

  it("handles a large document", () => {
    const paragraph = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ";
    const html = Array.from({ length: 4_000 }, (_, i) => `<p>${paragraph}${i}</p>`).join("");
    const { body } = page(html);
    const doc = new AnchorDocument(body);
    expect(doc.text.length).toBeGreaterThan(200_000);
    const anchor = textAnchor(doc, {
      start: at(body, "elit. 3999"),
      end: at(body, "elit. 3999", 10),
    });
    expect(doc.resolveText(anchor)).toMatchObject({ confidence: "exact", text: "elit. 3999" });
  });
});
