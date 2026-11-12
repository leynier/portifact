// Every entry of the closed lists that decide what is safe (the HTML subset, the preview's kept and
// dropped elements and attributes, the text a page does not show), one case each, so removing or
// misspelling an entry fails a test.
import { describe, expect, it } from "vitest";
import { RENDERER } from "../testing/suggestions/harness.ts";
import { find, type P5Element, parseHtml, shownTextNodes, skeleton } from "./html-dom.ts";
import { safeUrl, subsetRefusal } from "./html-subset.ts";
import { buildPreview, previewable } from "./preview.ts";
import { newWork } from "./work.ts";

const doc = (body: string, head = "") =>
  `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
const refusal = (html: string) => subsetRefusal(html, parseHtml(html, newWork()));
const preview = (body: string) => buildPreview("html", doc(body), RENDERER);

/** Each element in a context where the parser keeps it, with text inside where it can hold any. */
const IN_CONTEXT: Record<string, string> = {
  li: "<ul><li>x</li></ul>",
  dt: "<dl><dt>x</dt></dl>",
  dd: "<dl><dd>x</dd></dl>",
  caption: "<table><caption>x</caption></table>",
  thead: "<table><thead><tr><td>x</td></tr></thead></table>",
  tbody: "<table><tbody><tr><td>x</td></tr></tbody></table>",
  tfoot: "<table><tfoot><tr><td>x</td></tr></tfoot></table>",
  tr: "<table><tbody><tr><td>x</td></tr></tbody></table>",
  th: "<table><tbody><tr><th>x</th></tr></tbody></table>",
  td: "<table><tbody><tr><td>x</td></tr></tbody></table>",
  table: "<table><tbody><tr><td>x</td></tr></tbody></table>",
  colgroup: "<table><colgroup><col></colgroup><tbody><tr><td>x</td></tr></tbody></table>",
  col: "<table><colgroup><col></colgroup><tbody><tr><td>x</td></tr></tbody></table>",
  summary: "<details><summary>x</summary></details>",
  br: "<p>a<br>b</p>",
  hr: "<hr>",
  wbr: "<p>a<wbr>b</p>",
  img: "<img>",
  input: '<input type="checkbox" disabled>',
};
const inContext = (tag: string) => IN_CONTEXT[tag] ?? `<${tag}>x</${tag}>`;

const SUBSET_BODY = [
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "em",
  "strong",
  "b",
  "i",
  "u",
  "s",
  "small",
  "mark",
  "code",
  "pre",
  "kbd",
  "samp",
  "var",
  "sub",
  "sup",
  "br",
  "hr",
  "wbr",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "main",
  "aside",
  "figure",
  "figcaption",
  "address",
  "abbr",
  "dfn",
  "bdi",
  "ul",
  "dl",
  "dt",
  "dd",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "table",
  "summary",
  "a",
  "img",
  "blockquote",
  "q",
  "del",
  "ins",
  "time",
  "ol",
  "li",
  "td",
  "th",
  "col",
  "colgroup",
  "bdo",
  "details",
  "input",
];

const SUBSET_ATTRIBUTES: [string, string][] = [
  ["a", "href"],
  ["a", "rel"],
  ["a", "hreflang"],
  ["a", "type"],
  ["img", "src"],
  ["img", "alt"],
  ["img", "width"],
  ["img", "height"],
  ["img", "loading"],
  ["img", "decoding"],
  ["blockquote", "cite"],
  ["q", "cite"],
  ["del", "cite"],
  ["del", "datetime"],
  ["ins", "cite"],
  ["ins", "datetime"],
  ["time", "datetime"],
  ["ol", "start"],
  ["ol", "reversed"],
  ["ol", "type"],
  ["li", "value"],
  ["td", "colspan"],
  ["td", "rowspan"],
  ["td", "headers"],
  ["th", "colspan"],
  ["th", "rowspan"],
  ["th", "headers"],
  ["th", "scope"],
  ["th", "abbr"],
  ["col", "span"],
  ["colgroup", "span"],
  ["bdo", "dir"],
  ["details", "open"],
  ["input", "checked"],
];

/** `<tag>` in its context with one more attribute on its first opening tag. */
const withAttribute = (tag: string, name: string) =>
  inContext(tag).replace(new RegExp(`<${tag}(?=[ >])`), `<${tag} ${name}="1"`);

describe("the HTML subset's lists", () => {
  it("accepts every listed body element", () => {
    for (const tag of SUBSET_BODY) expect(refusal(doc(inContext(tag))), tag).toBeNull();
  });

  it("accepts every listed attribute on its element, and refuses it on another", () => {
    for (const [tag, name] of SUBSET_ATTRIBUTES) {
      expect(refusal(doc(withAttribute(tag, name))), `${tag} ${name}`).toBeNull();
      if (!["type", "abbr", "value", "span", "dir"].includes(name)) {
        expect(refusal(doc(`<p ${name}="1">x</p>`)), `p ${name}`).toBe("attribute");
      }
    }
    for (const name of [
      "id",
      "class",
      "title",
      "lang",
      "dir",
      "style",
      "hidden",
      "role",
      "translate",
      "tabindex",
      "aria-label",
      "data-x",
    ]) {
      expect(refusal(doc(`<p ${name}="1">x</p>`)), name).toBeNull();
    }
    for (const name of ["data-", "data-a_b", "onclick", "srcset", "aria"]) {
      expect(refusal(doc(`<p ${name}="1">x</p>`)), name).toBe("attribute");
    }
  });

  it("accepts the head's elements and attributes only in the head", () => {
    const head =
      '<meta charset="utf-8"><meta name="x" content="y"><link rel="stylesheet" href="a.css" type="text/css" media="all"><link rel="icon" href="i.png" sizes="16x16"><style media="all">p{}</style>';
    expect(refusal(doc("<p>x</p>", head))).toBeNull();
    expect(refusal(doc("<p>x</p>", '<link rel="ICON" href="i.png">'))).toBeNull();
    expect(refusal(doc("<p>x</p>", '<meta charset="UTF-8">'))).toBeNull();
    for (const tag of [
      "<style>p{}</style>",
      '<link rel="icon" href="i.png">',
      '<meta name="x" content="y">',
    ]) {
      expect(refusal(doc(`<p>x</p>${tag}`)), tag).toBe("head_only");
    }
    expect(refusal(doc("<p>x</p>", '<link href="a.css">'))).toBe("attribute");
  });

  it("takes a checkbox only when disabled, and other inputs never", () => {
    expect(refusal(doc('<input type="checkbox" disabled checked>'))).toBeNull();
    expect(refusal(doc('<input type="checkbox">'))).toBe("element");
    expect(refusal(doc('<input type="text" disabled>'))).toBe("element");
  });

  it("refuses URLs with schemes browsers read through controls and DEL", () => {
    expect(safeUrl("href", "\u007fjavascript:alert(1)")).toBe(false);
    expect(safeUrl("href", "\u007fhttps://e.example/")).toBe(true);
    expect(refusal(doc('<a href="https://e.example/x:y">x</a>'))).toBeNull();
    expect(refusal(doc('<img src="mailto:a@b.example">'))).toBe("url");
  });

  it("refuses files at the limits' next unit, and accepts them at the limits", () => {
    const base = doc("<p></p>");
    const filler = (bytes: number) => doc(`<p>${"x".repeat(bytes - base.length)}</p>`);
    expect(refusal(filler(1_048_576))).toBeNull();
    expect(refusal(filler(1_048_577))).toBe("too_large");
    // html, head, title and its text, body: 5 nodes besides the document, doctype and the `i`s.
    const nodes = (count: number) => doc("<i></i>".repeat(count - 7));
    expect(refusal(nodes(50_000))).toBeNull();
    expect(refusal(nodes(50_001))).toBe("too_large");
  });

  it("refuses an element outside the HTML namespace even when its name is allowed", () => {
    expect(refusal(doc("<svg><a>x</a></svg>"))).toBe("element");
  });
});

describe("the preview's lists", () => {
  it("writes every kept element", () => {
    for (const tag of [
      "div",
      "span",
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "a",
      "em",
      "strong",
      "b",
      "i",
      "u",
      "s",
      "small",
      "mark",
      "code",
      "pre",
      "kbd",
      "samp",
      "var",
      "sub",
      "sup",
      "br",
      "hr",
      "wbr",
      "section",
      "article",
      "header",
      "footer",
      "nav",
      "main",
      "aside",
      "figure",
      "figcaption",
      "address",
      "abbr",
      "dfn",
      "bdi",
      "bdo",
      "ul",
      "ol",
      "li",
      "dl",
      "dt",
      "dd",
      "table",
      "caption",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "th",
      "td",
      "colgroup",
      "col",
      "blockquote",
      "q",
      "cite",
      "del",
      "ins",
      "time",
      "details",
      "summary",
    ]) {
      expect(preview(inContext(tag)), tag).toContain(`<${tag}>`);
    }
  });

  it("drops every dropped element with its content", () => {
    for (const tag of [
      "script",
      "noscript",
      "iframe",
      "object",
      "portal",
      "applet",
      "form",
      "button",
      "select",
      "textarea",
      "option",
      "datalist",
      "video",
      "audio",
      "canvas",
      "map",
      "picture",
      "xmp",
      "noembed",
      "noframes",
      "dialog",
      "slot",
    ]) {
      const html = preview(`<p>kept</p><${tag}>secret</${tag}>`);
      expect(html, tag).toContain("kept");
      expect(html, tag).not.toContain("secret");
    }
    expect(preview("<p>kept</p><plaintext>secret")).not.toContain("secret");
    expect(preview("<p>kept</p><title>secret</title>")).not.toContain("secret");
  });

  it("keeps every listed attribute and no other", () => {
    for (const name of [
      "id",
      "class",
      "title",
      "lang",
      "dir",
      "style",
      "hidden",
      "role",
      "alt",
      "width",
      "height",
      "colspan",
      "rowspan",
      "headers",
      "scope",
      "start",
      "reversed",
      "type",
      "value",
      "datetime",
      "open",
      "span",
      "abbr",
      "translate",
      "disabled",
      "checked",
    ]) {
      expect(preview(`<p ${name}="v">x</p>`), name).toContain(`<p ${name}="v">`);
    }
    expect(preview('<p href="/x" data-a="1" onclick="1">x</p>')).toContain("<p>x</p>");
  });

  it("writes Markdown and text in the document's main element, and only the head's styles", () => {
    expect(buildPreview("markdown", "a", RENDERER)).toContain(
      '<main class="pf-document pf-markdown">',
    );
    expect(buildPreview("text", "a", RENDERER)).toContain(
      '<main class="pf-document"><pre class="pf-text">',
    );
    const head = buildPreview(
      "html",
      doc("<p>x</p>", '<meta name="a" content="secret"><style>q{}</style>'),
      RENDERER,
    );
    expect(head).toContain("<style>q{}</style>");
    expect(head).not.toContain("secret");
  });

  it("previews files up to the limits exactly", () => {
    expect(previewable("markdown", "x".repeat(2_000_000))).toBe(true);
    expect(previewable("text", "x".repeat(2_000_001))).toBe(false);
    expect(previewable("html", "x".repeat(1_048_577))).toBe(false);
  });
});

describe("what a page does not show, and the skeleton", () => {
  const shown = (body: string) => {
    const document = parseHtml(doc(body), newWork()).document;
    return shownTextNodes(find(document, "body") as P5Element).map((node) => node.value);
  };

  it("leaves out text in every unshown element and in Portifact's chrome", () => {
    for (const tag of ["script", "style", "noscript", "textarea", "title"]) {
      expect(shown(`<p>a</p><${tag}>secret</${tag}>`), tag).toEqual(["a"]);
    }
    expect(shown("<p>a</p><template>secret</template>")).toEqual(["a"]);
    expect(shown("<p>a</p><footer data-portifact-ignore><a>secret</a></footer>")).toEqual(["a"]);
  });

  it("changes with the doctype, a title or style text, an attribute, a namespace or nesting", () => {
    const of = (html: string) => skeleton(parseHtml(html, newWork()).document);
    const base =
      "<!doctype html><html><head><title>t</title><style>p{}</style></head><body><p class=a>x</p><p>y</p></body></html>";
    expect(of(base)).toBe(of(base.replace(">x<", ">changed<")));
    for (const changed of [
      base.replace("<!doctype html>", "<!doctype other>"),
      base.replace("<title>t", "<title>u"),
      base.replace("p{}", "q{}"),
      base.replace("class=a", "class=b"),
      base.replace("class=a", "id=a"),
      base.replace("<p>y</p>", "<p><span>y</span></p>"),
      base.replace("<p class=a>x</p><p>y</p>", "<p class=a>x<p>y</p></p>"),
      base.replace("<p>y</p>", "<p>y</p><!-- c -->"),
      base.replace("<p>y</p>", "<svg><a>y</a></svg>"),
      base.replace("<p>y</p>", '<svg><a xlink:href="x">y</a></svg>'),
    ]) {
      expect(of(changed), changed).not.toBe(of(base));
    }
    expect(of(base.replace("<p>y</p>", '<svg><a xlink:href="x">y</a></svg>'))).not.toBe(
      of(base.replace("<p>y</p>", '<svg><a href="x">y</a></svg>')),
    );
  });
});
