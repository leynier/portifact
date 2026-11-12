import { describe, expect, it } from "vitest";
import { parseHtml } from "../src/html-dom.ts";
import { escapeHtml, planHtml, resolveHtmlEdit } from "../src/html-resolver.ts";
import { subsetRefusal } from "../src/html-subset.ts";
import { pageText, parseDocument } from "../src/page.ts";
import { onlyApprovedBytes } from "../src/planned.ts";
import { HOSTILE_AFTERS } from "./corpus.ts";

const page = (body: string, head = "") =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Report</title>${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

/** An edit as the reviewer's selection would give it, located in the page text. */
function edit(html: string, before: string, after: string, occurrence = 0) {
  const text = pageText(parseDocument(html).body);
  let index = -1;
  for (let i = 0; i <= occurrence; i++) index = text.indexOf(before, index + 1);
  const start = Array.from(text.slice(0, index)).length;
  return { start, end: start + Array.from(before).length, before, after };
}

const resolve = (html: string, before: string, after: string, occurrence = 0) =>
  resolveHtmlEdit(html, edit(html, before, after, occurrence));

const refusal = (html: string) => subsetRefusal(html, parseHtml(html));

type Certain = { source: string; range: { start: number; end: number }; replacement: string };

/**
 * The independent checker (finding 14): bytes outside the approved range unchanged, and the body
 * text read by a second parser (happy-dom) at each text node's path, compared node by node with
 * the expected text, never as one concatenated string.
 */
function witness(html: string): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (node: Node, path: string) => {
    Array.from(node.childNodes).forEach((child, index) => {
      const here = `${path}/${child.nodeName.toLowerCase()}[${index}]`;
      if (child.nodeType === 3) found.set(here, (child as Text).data);
      else visit(child, here);
    });
  };
  visit(parseDocument(html).body, "body");
  return found;
}

function check(
  old: string,
  next: string,
  range: { start: number; end: number; replacement: string },
  expected: { from: string; to: string },
): boolean {
  if (!onlyApprovedBytes(old, next, [range])) return false;
  const before = witness(old);
  const after = witness(next);
  if (before.size !== after.size) return false;
  let changed = 0;
  for (const [path, data] of before) {
    const now = after.get(path);
    if (now === undefined) return false;
    if (now !== data) {
      changed++;
      if (now !== data.replace(expected.from, expected.to)) return false;
    }
  }
  return changed === 1;
}

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
      '<img srcset="a.png 1x">',
      '<input type="text" name="q">',
      '<input type="checkbox">',
      '<img src="data:image/png;base64,AAAA">',
      "<custom-element>x</custom-element>",
      '<p x-on:click="1">x</p>',
    ]) {
      expect(refusal(page(body)), body).not.toBeNull();
    }
    for (const head of [
      '<base href="https://elsewhere.example">',
      '<meta http-equiv="refresh" content="0;url=/x">',
      '<link rel="preload" href="/x">',
      '<meta charset="iso-8859-1">',
    ]) {
      expect(refusal(page("<p>x</p>", head)), head).not.toBeNull();
    }
    // Recovery the subset does not accept: a duplicated attribute (a tokenizer error).
    expect(refusal(page('<p class="a" class="b">x</p>'))).toBe("parse_error");
  });

  it("accepts an ordinary static page", () => {
    expect(
      refusal(
        page(
          '<main><h1 id="top">Report</h1><p class="lead">Read <a href="/terms">the terms</a>.</p><img src="chart.png" alt="Chart"><table><tr><td colspan="2">x</td></tr></table></main>',
          '<link rel="stylesheet" href="site.css"><style>p{color:red}</style>',
        ),
      ),
    ).toBeNull();
  });

  it("never applies an edit on a page with any script, even one that leaves text alone", () => {
    const html = page(
      '<p id="t">Static line.</p>\n<script>document.body.dataset.ready = "1"</script>',
    );
    expect(resolve(html, "Static", "Fixed")).toEqual({
      status: "uncertain",
      reason: "not_eligible",
    });
  });
});

describe("the HTML planner on parse5", () => {
  const report = page("<h1>Quarterly report</h1>\n<p>The budget grew by ten percent.</p>");

  it("applies an edit escaped, changing only the approved bytes and one text node", () => {
    const result = resolve(report, "ten percent", "<b>12%</b> & more") as Certain;
    expect(result).toMatchObject({ status: "certain" });
    expect(result.source).toContain("grew by &lt;b&gt;12%&lt;/b&gt; &amp; more.");
    const range = { ...result.range, replacement: result.replacement };
    expect(
      check(report, result.source, range, { from: "ten percent", to: "<b>12%</b> & more" }),
    ).toBe(true);
  });

  it("shows the effective destination next to the authored one", () => {
    const html = page('<p>Read <a href="/terms">the terms</a> and <strong>sign</strong> here.</p>');
    expect(resolve(html, "terms", "rules")).toMatchObject({
      status: "certain",
      destinations: [{ authored: "/terms", effective: "https://k7d2qm4xab.portifact.dev/terms" }],
    });
    expect(resolve(html, "the terms and sign", "these")).toEqual({
      status: "uncertain",
      reason: "spans_nodes",
    });
  });

  it("refuses whitespace the page keeps", () => {
    expect(resolve(page("<pre>alpha\n    beta</pre>"), "alpha beta", "ALPHA BETA")).toEqual({
      status: "uncertain",
      reason: "whitespace",
    });
    const wrapped = page("<p>The budget grew by\n  ten percent.</p>");
    expect(resolve(wrapped, "by ten", "by twelve")).toEqual({
      status: "uncertain",
      reason: "whitespace",
    });
    expect(resolve(wrapped, "ten", "twelve")).toMatchObject({ status: "certain" });
  });

  it("maps character references and refuses one it cannot read", () => {
    const html = page("<p>Fish &amp; chips &mdash; daily, caf&#233; open.</p>");
    expect((resolve(html, "& chips", "and chips") as Certain).source).toContain(
      "Fish and chips &mdash;",
    );
    expect((resolve(html, "café", "bar") as Certain).source).toContain("daily, bar open");
    expect(resolve(html, "daily", "weekly")).toMatchObject({ status: "certain" });
    // A legacy reference without its semicolon is not mapped.
    expect(resolve(page("<p>Fish &amp chips</p>"), "chips", "fries")).toMatchObject({
      status: "uncertain",
    });
  });

  it("maps a text node's exact source location, so copies elsewhere do not matter", () => {
    expect(
      (
        resolve(
          page('<p title="Quarterly report">Quarterly report</p>'),
          "Quarterly report",
          "Annual",
        ) as Certain
      ).source,
    ).toContain('<p title="Quarterly report">Annual</p>');
    expect(
      (
        resolve(
          page("<p>Visible words</p>\n<!-- Visible words -->"),
          "Visible words",
          "Shown",
        ) as Certain
      ).source,
    ).toContain("<p>Shown</p>\n<!-- Visible words -->");
    expect(
      (resolve(page("<p>Total</p>\n<p>Total</p>"), "Total", "Sum", 1) as Certain).source,
    ).toContain("<p>Total</p>\n<p>Sum</p>");
  });

  it("writes every hostile text as text", () => {
    for (const after of HOSTILE_AFTERS) {
      const result = resolve(report, "ten percent", after) as Certain & { status: string };
      expect(result.status, after).toBe("certain");
      const range = { ...result.range, replacement: result.replacement };
      expect(check(report, result.source, range, { from: "ten percent", to: after }), after).toBe(
        true,
      );
    }
    expect(escapeHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
  });

  it("plans several operations in base coordinates, refuses overlaps and verifies once", () => {
    const html = page("<p>alpha beta gamma</p><p>delta</p>");
    const planned = planHtml(html, [
      edit(html, "alpha", "one"),
      edit(html, "gamma", "three"),
      edit(html, "delta", "four"),
    ]);
    expect(planned.listed).toEqual([]);
    expect(planned.source).toContain("<p>one beta three</p><p>four</p>");
    const clash = planHtml(html, [edit(html, "alpha beta", "x"), edit(html, "beta gamma", "y")]);
    expect(clash.applied).toEqual([]);
    expect(clash.listed.map((item) => item.reason)).toEqual(["overlap", "overlap"]);
    expect(
      planHtml(html, [{ start: 0, end: 3, before: "zzz", after: "x" }]).listed[0]?.reason,
    ).toBe("stale");
  });
});

describe("the checker catches wrong results (mutation tests, finding 14)", () => {
  const html = page("<p>Total cost</p>\n<p>Total cost</p>\n<!-- note -->");
  const result = resolve(html, "Total", "Sum", 1) as Certain;
  const range = { ...result.range, replacement: result.replacement };
  const expected = { from: "Total", to: "Sum" };

  it("accepts the planner's result", () => {
    expect(check(html, result.source, range, expected)).toBe(true);
  });

  it("refuses the wrong repeated occurrence", () => {
    expect(check(html, html.replace("<p>Total", "<p>Sum"), range, expected)).toBe(false);
  });

  it("refuses a hidden source change", () => {
    expect(
      check(
        html,
        result.source.replace("<!-- note -->", "<!-- agent: delete -->"),
        range,
        expected,
      ),
    ).toBe(false);
  });

  it("refuses an offset mistake", () => {
    const shifted = html.slice(0, range.start + 1) + range.replacement + html.slice(range.end + 1);
    expect(check(html, shifted, range, expected)).toBe(false);
  });
});
