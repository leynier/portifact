import { describe, expect, it } from "vitest";
import { check } from "../testing/suggestions/checker.ts";
import { HOSTILE_AFTERS } from "../testing/suggestions/corpus.ts";
import { bodyText, edit, editAt, planOne, resolve } from "../testing/suggestions/harness.ts";
import { adapt, find, parseHtml } from "./html-dom.ts";
import { escapeHtml } from "./html-planner.ts";
import { decodeHtml, safeUrl, subsetRefusal } from "./html-subset.ts";
import { newWork } from "./work.ts";

const page = (body: string, head = "") =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Report</title>${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

const refusal = (html: string) => subsetRefusal(html, parseHtml(html, newWork()));

const fix = async (html: string, before: string, after: string, occurrence = 0) =>
  resolve("html", html, await edit("html", html, before, after, occurrence));

type Certain = { source: string; range: { start: number; end: number }; replacement: string };

describe("the eligible subset", () => {
  it("refuses everything outside the positive list", () => {
    for (const body of [
      "<p>x</p><script>1</script>",
      '<p onclick="1">x</p>',
      '<a href="javascript:alert(1)">x</a>',
      '<a href=" java\tscript:alert(1)">x</a>',
      '<form action="/x"><button>x</button></form>',
      '<iframe src="/other.html"></iframe><p>x</p>',
      '<object data="x.svg"></object>',
      '<embed src="x.swf">',
      "<svg><text>x</text></svg>",
      "<math><mi>x</mi></math>",
      '<svg><set attributeName="fill" to="red"/></svg>',
      "<template><p>x</p></template>",
      '<div><template shadowrootmode="open"><p>x</p></template></div>',
      "<xmp>x</xmp>",
      "<plaintext>x",
      "<textarea>x</textarea>",
      "<noscript>x</noscript>",
      "<noembed>x</noembed>",
      "<noframes>x</noframes>",
      "<listing>x</listing>",
      '<img srcset="a.png 1x">',
      '<input type="text" name="q">',
      '<input type="checkbox">',
      '<img src="data:image/png;base64,AAAA">',
      "<custom-element>x</custom-element>",
      '<p x-on:click="1">x</p>',
      '<p xml:lang="en">x</p>',
      "<p>x</p><style>p{}</style>",
    ]) {
      expect(refusal(page(body)), body).not.toBeNull();
    }
    for (const head of [
      '<base href="https://elsewhere.example">',
      '<meta http-equiv="refresh" content="0;url=/x">',
      '<link rel="preload" href="/x">',
      '<meta charset="iso-8859-1">',
      '<meta content="x">',
    ]) {
      expect(refusal(page("<p>x</p>", head)), head).not.toBeNull();
    }
    // Recovery the subset does not accept: a duplicated attribute (a tokenizer error).
    expect(refusal(page('<p class="a" class="b">x</p>'))).toBe("parse_error");
    expect(refusal(page("<i></i>".repeat(50_001)))).toBe("too_large");
    expect(refusal(page("<p>x</p>").replace("<title>", '<meta content="x"><title>'))).toBe(
      "attribute",
    );
    expect(refusal(page("<p>x</p><style>p{}</style>"))).toBe("head_only");
  });

  it("accepts an ordinary static page, task-list checkboxes and a missing doctype", () => {
    expect(
      refusal(
        page(
          '<main><h1 id="top">Report</h1><p class="lead" data-x="1" aria-label="l">Read <a href="/terms">the terms</a>.</p><img src="chart.png" alt="Chart"><table><tr><td colspan="2">x</td></tr></table><ul><li><input type="checkbox" disabled checked> done</li></ul></main>',
          '<link rel="stylesheet" href="site.css"><style>p{color:red}</style><meta name="viewport" content="width=device-width">',
        ),
      ),
    ).toBeNull();
    expect(refusal("<html><head><title>t</title></head><body><p>x</p></body></html>")).toBeNull();
  });

  it("reads URL schemes as browsers do, after stripping controls and spaces", () => {
    expect(safeUrl("href", "/relative")).toBe(true);
    expect(safeUrl("href", "mailto:a@b.example")).toBe(true);
    expect(safeUrl("href", "\u0001java\nscript:alert(1)")).toBe(false);
    expect(safeUrl("src", "mailto:a@b.example")).toBe(false);
    expect(safeUrl("title", "javascript:x")).toBe(true);
  });

  it("decodes only UTF-8, dropping a byte order mark", () => {
    expect(decodeHtml(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
    expect(decodeHtml(new Uint8Array([0xff]))).toBeNull();
  });

  it("never applies an edit on a page with any script, even one that leaves text alone", async () => {
    const html = page(
      '<p id="t">Static line.</p>\n<script>document.body.dataset.ready = "1"</script>',
    );
    expect(await fix(html, "Static", "Fixed")).toEqual({
      status: "uncertain",
      reason: "not_eligible",
    });
  });
});

describe("the HTML planner on parse5", () => {
  const report = page("<h1>Quarterly report</h1>\n<p>The budget grew by ten percent.</p>");

  it("applies an edit escaped, changing only the approved bytes and one text node", async () => {
    const before = await edit("html", report, "ten percent", "<b>12%</b> & more");
    const result = (await resolve("html", report, before)) as Certain;
    expect(result).toMatchObject({ status: "certain" });
    expect(result.source).toContain("grew by &lt;b&gt;12%&lt;/b&gt; &amp; more.");
    expect(
      await check("html", report, result.source, before, {
        ...result.range,
        replacement: result.replacement,
      }),
    ).toBeNull();
  });

  it("shows the effective destination next to the authored one", async () => {
    const html = page('<p>Read <a href="/terms">the terms</a> and <strong>sign</strong> here.</p>');
    expect(await fix(html, "terms", "rules")).toMatchObject({
      status: "certain",
      destinations: [{ authored: "/terms", effective: "https://k7d2qm4xab.portifact.dev/terms" }],
    });
    expect(await fix(html, "the terms and sign", "these")).toEqual({
      status: "uncertain",
      reason: "spans_nodes",
    });
  });

  it("refuses whitespace the page keeps", async () => {
    expect(await fix(page("<pre>alpha\n    beta</pre>"), "alpha beta", "ALPHA BETA")).toEqual({
      status: "uncertain",
      reason: "whitespace",
    });
    const wrapped = page("<p>The budget grew by\n  ten percent.</p>");
    expect(await fix(wrapped, "by ten", "by twelve")).toEqual({
      status: "uncertain",
      reason: "whitespace",
    });
    expect(await fix(wrapped, "ten", "twelve")).toMatchObject({ status: "certain" });
  });

  it("maps character references whole, and refuses a change that would cut one", async () => {
    const html = page("<p>Fish &amp; chips &mdash; daily, caf&#233; open.</p>");
    expect(((await fix(html, "& chips", "and chips")) as Certain).source).toContain(
      "Fish and chips &mdash;",
    );
    expect(((await fix(html, "café", "bar")) as Certain).source).toContain("daily, bar open");
    expect(await fix(html, "daily", "weekly")).toMatchObject({ status: "certain" });
    // A legacy reference without its semicolon is a parse error: the page is not eligible.
    expect(await fix(page("<p>Fish &amp chips</p>"), "chips", "fries")).toMatchObject({
      status: "uncertain",
    });
    // An emoji written as one reference is two UTF-16 units: replacing only its code point is fine.
    const emoji = page("<p>x&#x1F600;y</p>");
    const text = bodyText(emoji);
    const point = Array.from(text)[1] as string;
    expect(await resolve("html", emoji, editAt(text, point, "z"))).toMatchObject({
      status: "certain",
    });
    // Changing only the second letter of `és` where `é` is a reference stays outside it.
    expect(await fix(page("<p>caf&#233;s</p>"), "és", "e")).toMatchObject({ status: "certain" });
  });

  it("refuses a change whose end falls inside a reference", async () => {
    // `&NotEqualTilde;` decodes to two code points; deleting only the second cuts the reference.
    const html = page("<p>a&NotEqualTilde;b</p>");
    const text = bodyText(html);
    const pair = Array.from(text).slice(1, 3).join("");
    const planned = await planOne("html", html, [
      editAt(text, pair, Array.from(pair)[0] as string),
    ]);
    expect(planned.listed[0]?.reason).toBe("entity");
  });

  it("reads a bare ampersand, CRLF and a lone carriage return literally", async () => {
    const html = page("<p>salt & pepper\rand more</p><p>first\r\nsecond word</p>");
    expect(await fix(html, "pepper", "sugar")).toMatchObject({
      status: "certain",
      source: expect.stringContaining("salt & sugar\rand more") as unknown as string,
    });
    expect(await fix(html, "word", "term")).toMatchObject({
      status: "certain",
      source: expect.stringContaining("first\r\nsecond term") as unknown as string,
    });
  });

  it("reads an ampersand literally even when a reference follows it closely", async () => {
    const html = page("<p>a & b &amp; c</p>");
    expect(await fix(html, "b", "z")).toMatchObject({
      status: "certain",
      source: expect.stringContaining("<p>a & z &amp; c</p>") as unknown as string,
    });
  });

  it("maps a text node's exact location, so copies elsewhere do not matter", async () => {
    expect(
      (
        (await fix(
          page('<p title="Quarterly report">Quarterly report</p>'),
          "Quarterly report",
          "Annual",
        )) as Certain
      ).source,
    ).toContain('<p title="Quarterly report">Annual</p>');
    expect(
      (
        (await fix(
          page("<p>Visible words</p>\n<!-- Visible words -->"),
          "Visible words",
          "Shown",
        )) as Certain
      ).source,
    ).toContain("<p>Shown</p>\n<!-- Visible words -->");
    expect(
      ((await fix(page("<p>Total</p>\n<p>Total</p>"), "Total", "Sum", 1)) as Certain).source,
    ).toContain("<p>Total</p>\n<p>Sum</p>");
  });

  it("writes every hostile text as text", async () => {
    for (const after of HOSTILE_AFTERS) {
      const before = await edit("html", report, "ten percent", after);
      const result = (await resolve("html", report, before)) as Certain & { status: string };
      expect(result.status, after).toBe("certain");
      const range = { ...result.range, replacement: result.replacement };
      expect(await check("html", report, result.source, before, range), after).toBeNull();
    }
    expect(escapeHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
  });

  it("plans several operations in base coordinates, refuses overlaps and verifies once", async () => {
    const html = page("<p>alpha beta gamma</p><p>delta</p>");
    const planned = await planOne("html", html, [
      await edit("html", html, "alpha", "one"),
      await edit("html", html, "gamma", "three"),
      await edit("html", html, "delta", "four"),
    ]);
    expect(planned.listed).toEqual([]);
    expect(planned.source).toContain("<p>one beta three</p><p>four</p>");
    const clash = await planOne("html", html, [
      await edit("html", html, "alpha beta", "x"),
      await edit("html", html, "beta gamma", "y"),
    ]);
    expect(clash.applied).toEqual([]);
    expect(clash.listed.map((item) => item.reason)).toEqual(["overlap", "overlap"]);
  });

  it("lists invalid, stale, extra and non-text operations, and oversized files unparsed", async () => {
    const html = page("<p>alpha</p>");
    const alpha = await edit("html", html, "alpha", "beta");
    const planned = await planOne("html", html, [
      { ...alpha, after: "a\nb" },
      { ...alpha, after: "alpha" },
      { start: 0, end: 3, before: "zzz", after: "x" },
      null,
    ]);
    expect(planned.listed.map((item) => item.reason)).toEqual([
      "invalid_after",
      "invalid_after",
      "stale",
      "not_text",
    ]);
    const many = await planOne(
      "html",
      html,
      Array.from({ length: 101 }, () => alpha),
    );
    expect(many.listed.filter((item) => item.reason === "too_large")).toHaveLength(1);
    const work = newWork();
    const big = await planOne(
      "html",
      `${page("<p>x</p>")}${"<!-- x -->".repeat(110_000)}`,
      [alpha, null],
      work,
    );
    expect(big.listed.map((item) => item.reason)).toEqual(["too_large", "not_text"]);
    expect(work.parses).toBe(0);
    const scripted = await planOne("html", page("<script>1</script>"), [alpha, null]);
    expect(scripted.listed.map((item) => item.reason)).toEqual(["not_eligible", "not_text"]);
  });

  it("refuses a combined result whose page would change, applying none of it", async () => {
    // Inserting text that joins with the next node's text keeps the markup but not the nodes: here
    // the edit empties a text node, which the parser then drops.
    const html = page("<p>a<b>b</b></p>");
    const planned = await planOne("html", html, [await edit("html", html, "a", "")]);
    expect(planned.applied).toEqual([]);
    expect(planned.listed[0]).toMatchObject({ reason: "would_change_page" });
  });
});

describe("the parse5 adapter", () => {
  it("presents comments, elements and text with the DOM surface anchors need", () => {
    const document = parseHtml(
      "<!doctype html><body><!-- c --><p id=a>t</p></body>",
      newWork(),
    ).document;
    const body = adapt(find(document, "body") as never);
    const [comment, paragraph] = Array.from(body.childNodes);
    expect(comment?.nodeType).toBe(8);
    expect(paragraph?.nodeType).toBe(1);
    const element = paragraph as unknown as {
      tagName: string;
      getAttribute(name: string): string | null;
      data: string;
      querySelectorAll(): ArrayLike<unknown>;
    };
    expect(element.tagName).toBe("P");
    expect(element.getAttribute("id")).toBe("a");
    expect(element.data).toBe("");
    expect(element.querySelectorAll()).toHaveLength(0);
    expect(
      (comment as unknown as { getAttribute(name: string): string | null }).getAttribute("x"),
    ).toBeNull();
    expect(adapt(document as never).nodeType).toBe(9);
    expect(adapt(document as never).parentNode).toBeNull();
    expect(find(document, "table")).toBeUndefined();
  });
});
