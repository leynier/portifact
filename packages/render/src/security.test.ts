// Hostile input: the rendered Markdown must never execute script, load what the policy forbids or
// carry markup the author wrote as raw HTML (docs/security.md, "Untrusted content").
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TOKEN_CLASSES } from "./highlight.ts";
import { renderMarkdown } from "./markdown.ts";
import { attr, byTag, type Element, elements, fragment, text } from "./test-html.ts";
import { classifyUrl } from "./urls.ts";

/** Every element and attribute the Markdown renderer may produce. */
const ALLOWED: Record<string, readonly string[]> = {
  a: ["href", "rel", "title", "id", "class", "aria-label"],
  blockquote: [],
  br: [],
  code: ["class"],
  div: ["class", "tabindex"],
  em: [],
  h1: ["id"],
  h2: ["id"],
  h3: ["id"],
  h4: ["id"],
  h5: ["id"],
  h6: ["id"],
  hr: [],
  img: ["src", "alt", "title"],
  input: ["type", "class", "disabled", "checked"],
  li: ["id", "class"],
  ol: ["start", "class"],
  p: [],
  pre: ["class", "data-pf-diagram", "data-pf-diagram-source"],
  s: [],
  section: ["class", "aria-label"],
  span: ["class"],
  strong: [],
  sup: ["class"],
  table: [],
  tbody: [],
  td: ["class"],
  th: ["class"],
  thead: [],
  tr: [],
  ul: ["class"],
};

/** Classes the renderer writes on code: highlight tokens, fence languages and Mermaid blocks. */
const CLASS_VALUES: Record<string, (value: string) => boolean> = {
  span: (value) => TOKEN_CLASSES.includes(value),
  pre: (value) => value === "pf-mermaid",
  code: (value) => /^language-\S+$/.test(value),
};

/** Violations of the output allowlist and URL policy, as readable strings. */
function violations(html: string, remoteImages = false): string[] {
  const found: string[] = [];
  for (const element of elements(fragment(html))) {
    found.push(...elementViolations(element, remoteImages));
  }
  return found;
}

function elementViolations(element: Element, remoteImages: boolean): string[] {
  const allowed = ALLOWED[element.tagName];
  if (!allowed) return [`<${element.tagName}>`];
  const found: string[] = [];
  for (const { name, value } of element.attrs) {
    if (name !== "data-pf-block" && !allowed.includes(name)) {
      found.push(`${element.tagName}[${name}]`);
    }
    if (name === "data-pf-block" && !/^b\d+$/.test(value)) found.push(`block id ${value}`);
  }
  const classes = attr(element, "class");
  const allowedClass = CLASS_VALUES[element.tagName];
  if (classes !== undefined && allowedClass && !allowedClass(classes)) {
    found.push(`${element.tagName}.${classes}`);
  }
  const href = attr(element, "href");
  if (href !== undefined && !href.startsWith("#") && classifyUrl(href) === undefined) {
    found.push(`href ${href}`);
  }
  const src = attr(element, "src");
  if (src !== undefined) {
    const target = classifyUrl(src);
    if (target === undefined || (target === "remote" && !remoteImages)) found.push(`src ${src}`);
  }
  return found;
}

const VECTORS = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<svg/onload=alert(1)>",
  '<a href="javascript:alert(1)">x</a>',
  "<iframe src=//evil.example></iframe>",
  "<object data=x></object><embed src=x>",
  "<style>body{display:none}</style>",
  '<meta http-equiv="refresh" content="0;url=//evil.example">',
  "<base href=//evil.example/>",
  '<form action=//evil.example><button formaction="javascript:alert(1)">x</button></form>',
  "<math><mi xlink:href=javascript:alert(1)>x</mi></math>",
  "<details open ontoggle=alert(1)>",
  "<!-- <script>alert(1)</script> -->",
  "<![CDATA[<script>alert(1)</script>]]>",
  "<div>\n\n*md inside html*\n\n</div>",
  "[x](javascript:alert(1))",
  "[x](JaVaScRiPt:alert(1))",
  "[x](javascript&#58;alert(1))",
  "[x](javascript&colon;alert(1))",
  "[x](&#106;avascript:alert(1))",
  "[x](<javascript:alert(1)>)",
  "[x](<java\tscript:alert(1)>)",
  "[x](vbscript:msgbox(1))",
  "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[x](file:///etc/passwd)",
  '[x](https://ok.example "title" onmouseover="alert(1)")',
  "[x][ref]\n\n[ref]: javascript:alert(1)",
  "<javascript:alert(1)>",
  "![x](javascript:alert(1))",
  "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
  '![x" onerror="alert(1)](a.png)',
  '![x](a.png "t\\" onerror=\\"alert(1)")',
  '```js" onmouseover="alert(1)\n```',
  "``` <script>alert(1)</script>\ncode\n```",
  "| <script>alert(1)</script> |\n|---|\n| <img src=x onerror=alert(1)> |",
  "- [x] <script>alert(1)</script>",
  "# <script>alert(1)</script>",
  "x[^<script>]\n\n[^<script>]: <img src=x onerror=alert(1)>",
  "www.example.com/<script>alert(1)</script>",
  'https://example.com/"onmouseover="alert(1)',
  "```html\n<script>alert(1)</script><img src=x onerror=alert(1)>\n```",
  "```js\n</code></pre><script>alert(1)</script>\n```",
  '```ts\nconst s = "<span class=\\"x\\" onclick=alert(1)>";\n```',
  "```xml\n<![CDATA[<script>alert(1)</script>]]><!-- <svg onload=alert(1)> -->\n```",
  "```markdown\n[x](javascript:alert(1)) <b>y</b>\n```",
  '```mermaid\nflowchart LR\n  A[<img src=x onerror=alert(1)>] --> B\n  click A href "javascript:alert(1)"\n```',
  '```mermaid\n%%{init: {"securityLevel": "loose", "htmlLabels": true}}%%\nflowchart LR\n  A["<script>alert(1)</script>"]\n```',
  "```mermaid\n</code></pre><script>alert(1)</script>\n```",
  '```mermaid" onmouseover="alert(1)\nflowchart LR\n```',
];

describe("hostile Markdown", () => {
  it.each(VECTORS)("renders %j without executable markup", (source) => {
    const { html } = renderMarkdown(source);
    expect(violations(html)).toEqual([]);
    expect(html).not.toMatch(/<(?:script|iframe|object|embed|style|svg|math|form|base|meta)\b/i);
  });

  it("shows raw HTML as literal text, so the author sees what they wrote", () => {
    const root = fragment(renderMarkdown('<b onclick="x()">bold</b> <!-- note -->').html);
    expect(byTag(root, "b")).toHaveLength(0);
    expect(text(root)).toContain('<b onclick="x()">bold</b> <!-- note -->');
  });

  it("drops the link but keeps the text when the scheme is not allowed", () => {
    const root = fragment(renderMarkdown("[click](javascript:alert(1))").html);
    expect(byTag(root, "a")).toHaveLength(0);
    expect(text(root)).toBe("[click](javascript:alert(1))\n");
  });

  it("marks links to other origins with nofollow, noopener and noreferrer", () => {
    const links = byTag(
      fragment(
        renderMarkdown("[a](https://x.example) [b](//x.example) [c](page.md) [d](#top)").html,
      ),
      "a",
    );
    expect(links.map((a) => attr(a, "rel"))).toEqual([
      "nofollow noopener noreferrer",
      "nofollow noopener noreferrer",
      undefined,
      undefined,
    ]);
  });

  describe("remote images", () => {
    const source = "![chart](https://cdn.example/c.png) ![](//cdn.example/d.png) ![local](a.png)";

    it("are links, not loads, by default", () => {
      const root = fragment(renderMarkdown(source).html);
      expect(byTag(root, "img").map((img) => attr(img, "src"))).toEqual(["a.png"]);
      expect(byTag(root, "a").map((a) => [attr(a, "href"), text(a), attr(a, "rel")])).toEqual([
        ["https://cdn.example/c.png", "chart", "nofollow noopener noreferrer"],
        ["//cdn.example/d.png", "//cdn.example/d.png", "nofollow noopener noreferrer"],
      ]);
    });

    it("load when the document opts in", () => {
      const { html } = renderMarkdown(source, { remoteImages: true });
      expect(violations(html, true)).toEqual([]);
      expect(byTag(fragment(html), "img").map((img) => attr(img, "src"))).toEqual([
        "https://cdn.example/c.png",
        "//cdn.example/d.png",
        "a.png",
      ]);
    });
  });

  it("never produces markup outside the allowlist for random hostile input", () => {
    const pieces = [
      ...VECTORS,
      "<",
      ">",
      "[",
      "]",
      "(",
      ")",
      "!",
      "*",
      "_",
      "`",
      "~",
      "|",
      "-",
      "#",
      "\n",
      "\n\n",
      " ",
      "    ",
      "\t",
      "\\",
      "&",
      "&#",
      ";",
      '"',
      "'",
      "=",
      ":",
      "javascript:",
      "data:",
      "www.",
      "http://",
      "//",
      "[^1]",
      "[^1]: ",
      "[x]",
      "- ",
      "1. ",
      "> ",
      "```",
      "```ts\n",
      "```html\n",
      "```mermaid\n",
      "</span>",
      '<span class="hljs-keyword">',
      "a",
      "on",
      "\u0000",
      " ",
    ];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...pieces), { maxLength: 40 }),
        fc.boolean(),
        (parts, remoteImages) => {
          const { html } = renderMarkdown(parts.join(""), { remoteImages });
          expect(violations(html, remoteImages)).toEqual([]);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("hostile Markdown size and shape", () => {
  const MB = 1_000_000;
  const fill = (unit: string, bytes = MB) => unit.repeat(Math.floor(bytes / unit.length));

  // micromark (remark) is quadratic on several of these; markdown-it is linear. A quadratic
  // parser needs many minutes on 1 MB of these inputs, so the budget stays generous for CI, where
  // every package's tests share the runner's CPU at once under coverage instrumentation, and still
  // catches a quadratic one. "nested links" takes about 1.3 s on a laptop and reached 20.1 s on the
  // release runner, so the budget is 60 s. The test timeout sits above the budget, so a slow run
  // fails on the assertion.
  it.each([
    ["nested emphasis openers and closers", fill("*a _b ", MB / 2) + fill("b_ a* ", MB / 2)],
    ["nested links", fill("[", MB / 2) + fill("](x)", MB / 2)],
    ["unclosed links", fill("[a ", MB / 2) + fill("](x) ", MB / 2)],
    ["long delimiter runs", fill(`${"*".repeat(256)}a${"*".repeat(256)}\n\n`)],
    ["thousands of footnotes", fill("x[^n]\n\n[^n]: y\n\n")],
    [
      "thousands of distinct footnotes",
      Array.from({ length: 40_000 }, (_, i) => `x[^${i}]\n\n[^${i}]: y`).join("\n\n"),
    ],
    ["deep block quotes", fill(">")],
    ["deep lists", Array.from({ length: 1_000 }, (_, i) => `${" ".repeat(i * 2)}- a`).join("\n")],
    ["backticks", fill("`a")],
    ["entities", fill("&amp;&#x1F600;&#0;&bogus;")],
    ["highlighted fences", fill("```ts\nconst a = `${b}` /* c */ // d\n```\n\n")],
    [
      "one long fence per language",
      ["html", "css", "ts", "py", "sh", "sql", "yaml", "rust", "diff"]
        .map((l) => `\`\`\`${l}\n${fill('<a b=\'c\'>{("d\\"e")}/*f*/ ', 99_000)}\n\`\`\``)
        .join("\n\n"),
    ],
    ["Mermaid blocks", fill("```mermaid\nflowchart LR\n  A --> B\n```\n\n")],
  ])(
    "renders %s quickly and without overflowing the stack",
    (_name, source) => {
      const started = performance.now();
      const { html } = renderMarkdown(source);
      expect(performance.now() - started).toBeLessThan(60_000);
      expect(html.length).toBeGreaterThan(0);
    },
    90_000,
  );

  it("caps nesting instead of recursing without bound", () => {
    const { html } = renderMarkdown(`${">".repeat(10_000)} deep`);
    expect(byTag(fragment(html), "blockquote").length).toBeLessThanOrEqual(100);
  });

  it("renders a realistic document at the size limit", () => {
    const section =
      "## Section\n\nSome *emphasis*, **strong**, a [link](https://example.com) and `code`.\n\n- one\n- two\n\n";
    const source = fill(section, 5 * MB - section.length);
    const started = performance.now();
    const { blocks } = renderMarkdown(source);
    // Linear rendering takes a second or two alone and has taken 32 on CI's shared runner; a
    // quadratic regression takes minutes, so this budget still tells them apart.
    expect(performance.now() - started).toBeLessThan(60_000);
    expect(blocks.length).toBeGreaterThan(100_000);
  }, 90_000);

  it("rejects Markdown over the size limit before parsing", () => {
    expect(() => renderMarkdown("a".repeat(5 * MB + 1))).toThrow(/limited/);
  });
});
