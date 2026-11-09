import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT_LIMITS,
  highlightBudget,
  highlightCode,
  isHighlighted,
  rebuild,
  TOKEN_CLASSES,
} from "./highlight.ts";
import { renderMarkdown } from "./markdown.ts";
import { attr, byTag, elements, fragment, text } from "./test-html.ts";

const LANGUAGES = [
  "ts",
  "js",
  "html",
  "css",
  "py",
  "sh",
  "json",
  "yaml",
  "sql",
  "rust",
  "go",
  "diff",
];

/** The `code` elements of a rendering, with their spans' classes and their text. */
function codeOf(source: string) {
  const root = fragment(renderMarkdown(source).html);
  return byTag(root, "code").map((code) => ({
    language: attr(code, "class"),
    block: attr(code, "data-pf-block"),
    spans: elements(code)
      .filter((element) => element.tagName === "span")
      .map((span) => attr(span, "class")),
    text: text(code),
  }));
}

describe("code highlighting", () => {
  it("marks keywords, types, strings and comments with token classes", () => {
    const [code] = codeOf('```ts\n// note\nconst a: string = "x";\n```');
    expect(code?.spans).toEqual([
      "pf-tok-comment",
      "pf-tok-keyword",
      "pf-tok-type",
      "pf-tok-string",
    ]);
    expect(code?.text).toBe('// note\nconst a: string = "x";\n');
    expect(code?.language).toBe("language-ts");
    expect(code?.block).toBe("b1");
  });

  it("answers to aliases and any case, and leaves other languages plain", () => {
    expect(
      ["TS", "JavaScript", "py", "sh", "zsh", "yml", "html", "golang", "rs"].map(isHighlighted),
    ).toEqual(Array(9).fill(true));
    expect(
      ["", "mermaid", "text", "brainfuck", "__proto__", "constructor"].map(isHighlighted),
    ).toEqual(Array(6).fill(false));
    expect(codeOf("```brainfuck\n+[-]\n```")[0]?.spans).toEqual([]);
    expect(codeOf("```\nconst a = 1\n```")[0]?.spans).toEqual([]);
    expect(codeOf("    const a = 1")[0]?.spans).toEqual([]);
  });

  it("reads the language from the first word of the info string", () => {
    const [code] = codeOf('```py title="x.py"\ndef f(): pass\n```');
    expect(code?.language).toBe("language-py");
    expect(code?.spans).toContain("pf-tok-keyword");
  });

  it("keeps embedded languages' tokens but drops their wrappers", () => {
    const [code] = codeOf(
      "```html\n<style>a { color: red }</style><script>let x = 1</script>\n```",
    );
    expect(code?.spans.every((c) => c !== undefined && TOKEN_CLASSES.includes(c))).toBe(true);
    expect(code?.spans).toContain("pf-tok-keyword");
    expect(code?.text).toBe("<style>a { color: red }</style><script>let x = 1</script>\n");
  });

  it("never changes the text and writes only token spans, for any code", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LANGUAGES),
        fc.string({ maxLength: 200 }),
        (language, body) => {
          const code = body.replace(/\r/g, "");
          const html = highlightCode(code, language, highlightBudget());
          if (html === undefined) return;
          const root = fragment(`<code>${html}</code>`);
          expect(text(root)).toBe(code);
          for (const element of elements(root)) {
            if (element.tagName === "code") continue;
            expect(element.tagName).toBe("span");
            expect(element.attrs.map((a) => a.name)).toEqual(["class"]);
            expect(TOKEN_CLASSES).toContain(attr(element, "class"));
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it("keeps the block map of a fence exactly as without highlighting", () => {
    const fenced = (language: string) =>
      renderMarkdown(`# T\n\n\`\`\`${language}\nconst a = 1;\nlet b = 2;\n\`\`\`\n\nafter\n`)
        .blocks;
    expect(fenced("ts")).toEqual(fenced("zz"));
    expect(isHighlighted("zz")).toBe(false);
  });

  it("shows a fence over the limit, and every fence after the budget is spent, plain", () => {
    const big = "let a = 1;\n".repeat(Math.ceil(HIGHLIGHT_LIMITS.fence / 11));
    expect(highlightCode(big, "ts", highlightBudget())).toBeUndefined();
    const budget = { remaining: 20 };
    expect(highlightCode("let a = 1;", "ts", budget)).toContain("pf-tok-keyword");
    expect(budget.remaining).toBe(10);
    expect(highlightCode("let b = 22;", "ts", budget)).toBeUndefined();
    expect(highlightCode("let c;", "ts", budget)).toContain("pf-tok-keyword");
    expect(highlightCode("let a;", "unknown", budget)).toBeUndefined();
    expect(budget.remaining).toBe(4);
  });

  it("spends the document's budget across fences", () => {
    const fence = `\`\`\`ts\n${"let a = 1;\n".repeat(9_000)}\`\`\``;
    const source = Array(7).fill(fence).join("\n\n");
    const highlighted = codeOf(source).map((code) => code.spans.length > 0);
    expect(highlighted).toEqual([true, true, true, true, true, false, false]);
  });
});

describe("rebuilding highlighter output", () => {
  it("escapes text again and maps known scopes", () => {
    expect(
      rebuild(
        '<span class="hljs-keyword">if</span> a &lt; b &amp;&amp; c &gt; &quot;d&#x27;',
        `if a < b && c > "d'`,
      ),
    ).toBe('<span class="pf-tok-keyword">if</span> a &lt; b &amp;&amp; c &gt; "d\'');
  });

  it("drops spans of unknown scopes with their closing tag, keeping what is inside", () => {
    expect(
      rebuild(
        '<span class="language-css"><span class="hljs-title function_">f</span><span class="hljs-string">s</span></span><span class="toString">x</span>',
        "fsx",
      ),
    ).toBe('f<span class="pf-tok-string">s</span>x');
  });

  it.each([
    ["another tag", "<b>x</b>", "x"],
    ["an attribute", '<span class="hljs-keyword" onclick="x">a</span>', "a"],
    ["an unclosed span", '<span class="hljs-keyword">a', "a"],
    ["a stray closing tag", "a</span>", "a"],
    ["a bare ampersand", "a & b", "a & b"],
    ["an unknown entity", "&nbsp;", " "],
    ["text that differs from the source", "a", "b"],
  ])("refuses %s", (_name, html, source) => {
    expect(rebuild(html, source)).toBeUndefined();
  });
});
