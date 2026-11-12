import { describe, expect, it } from "vitest";
import { escapeHtml, isInert, planHtml, rawInert, resolveHtmlEdit } from "../src/html-resolver.ts";
import { pageText, parseDocument, skeleton } from "../src/page.ts";
import { HOSTILE_AFTERS } from "./corpus.ts";

const page = (body: string, head = "") =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Report</title>${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

/** An edit as the reviewer's selection would give it, located in the stored file's page text. */
function edit(html: string, before: string, after: string, occurrence = 0) {
  const text = pageText(parseDocument(html).body);
  let index = -1;
  for (let i = 0; i <= occurrence; i++) index = text.indexOf(before, index + 1);
  const start = Array.from(text.slice(0, index)).length;
  return { start, end: start + Array.from(before).length, before, after };
}

const resolve = (html: string, before: string, after: string, occurrence = 0) =>
  resolveHtmlEdit(html, edit(html, before, after, occurrence));

/** The independent check: the raw text of the body, nothing normalized. */
const rawBody = (html: string) => parseDocument(html).body.textContent ?? "";

describe("which pages are inert", () => {
  it("refuses every page that can run something", () => {
    for (const body of [
      "<p>x</p><script>1</script>",
      '<p onclick="1">x</p>',
      '<a href="javascript:alert(1)">x</a>',
      '<a href=" java\tscript:alert(1)">x</a>',
      '<form action="JAVASCRIPT:1"><button formaction="javascript:1">x</button></form>',
      '<iframe src="/other.html"></iframe><p>x</p>',
      '<iframe srcdoc="<script>1</script>"></iframe>',
      '<object data="x.svg"></object>',
      '<embed src="x.swf">',
      "<svg><script>1</script></svg>",
      '<svg><a xlink:href="javascript:1"><text>x</text></a></svg>',
      '<img srcset="javascript:1 1x">',
      '<p>x</p><meta http-equiv="refresh" content="0;url=/x">',
    ]) {
      expect(isInert(parseDocument(page(body))) && rawInert(page(body)), body).toBe(false);
    }
    const plain = page('<p>Static <a href="/terms">terms</a>.</p>');
    expect(isInert(parseDocument(plain)) && rawInert(plain)).toBe(true);
    // happy-dom drops a script inside svg; the raw scan still refuses the page.
    expect(isInert(parseDocument(page("<svg><script>1</script></svg>")))).toBe(true);
    expect(rawInert(page("<svg><script>1</script></svg>"))).toBe(false);
  });

  it("never applies an edit on a page with any script, even one that leaves text alone", () => {
    const html = page(
      '<p id="t">Static line.</p>\n<script>document.body.dataset.ready = "1"</script>',
    );
    expect(resolve(html, "Static", "Fixed")).toEqual({ status: "uncertain", reason: "not_inert" });
  });
});

describe("static HTML resolver", () => {
  const report = page("<h1>Quarterly report</h1>\n<p>The budget grew by ten percent.</p>");

  it("applies an edit to an inert page, escaped, and only that text changes", () => {
    const result = resolve(report, "ten percent", "<b>12%</b> & more");
    expect(result).toMatchObject({ status: "certain" });
    const next = (result as { source: string }).source;
    expect(next).toContain("grew by &lt;b&gt;12%&lt;/b&gt; &amp; more.");
    expect(skeleton(parseDocument(next).documentElement)).toBe(
      skeleton(parseDocument(report).documentElement),
    );
    expect(rawBody(next)).toBe(rawBody(report).replace("ten percent", "<b>12%</b> & more"));
  });

  it("edits inside inline markup, shows the link's destination, and refuses across markup", () => {
    const html = page(
      '<p>Read <a href="https://example.com/terms">the terms</a> and <strong>sign</strong> here.</p>',
    );
    expect(resolve(html, "terms", "rules")).toMatchObject({
      status: "certain",
      destinations: ["https://example.com/terms"],
    });
    expect(resolve(html, "the terms and sign", "these")).toEqual({
      status: "uncertain",
      reason: "spans_nodes",
    });
  });

  it("refuses whitespace the page keeps or the file spells differently", () => {
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

  it("refuses text that also occurs in an attribute, a comment or twice", () => {
    expect(
      resolve(
        page('<p title="Quarterly report">Quarterly report</p>'),
        "Quarterly report",
        "Annual",
      ),
    ).toEqual({ status: "uncertain", reason: "not_found" });
    expect(
      resolve(page("<p>Visible words</p>\n<!-- Visible words -->"), "Visible words", "Shown"),
    ).toEqual({ status: "uncertain", reason: "not_found" });
    expect(resolve(page("<p>Total</p>\n<p>Total</p>"), "Total", "Sum")).toEqual({
      status: "uncertain",
      reason: "not_found",
    });
    const attribute = page('<p title="report">The report is late.</p>');
    const result = resolve(attribute, "report", "memo");
    expect((result as { source: string }).source).toContain(
      '<p title="report">The memo is late.</p>',
    );
  });

  it("refuses entities it cannot spell, and edits beside them", () => {
    const html = page("<p>Fish &amp; chips &mdash; daily.</p>");
    expect(resolve(html, "&", "and")).toMatchObject({ status: "uncertain" });
    expect(resolve(html, "daily", "weekly")).toMatchObject({ status: "certain" });
  });

  it("writes every hostile text as text", () => {
    for (const after of HOSTILE_AFTERS) {
      const result = resolve(report, "ten percent", after);
      expect(result.status, after).toBe("certain");
      const next = (result as { source: string }).source;
      expect(skeleton(parseDocument(next).documentElement)).toBe(
        skeleton(parseDocument(report).documentElement),
      );
      expect(rawBody(next)).toBe(rawBody(report).replace("ten percent", after));
    }
    expect(escapeHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
  });

  it("refuses stale and invalid edits", () => {
    expect(resolveHtmlEdit(report, { start: 0, end: 3, before: "xyz", after: "a" })).toEqual({
      status: "uncertain",
      reason: "stale",
    });
    expect(resolveHtmlEdit(report, { start: 0, end: 3, before: "Qua", after: "a\tb" })).toEqual({
      status: "uncertain",
      reason: "invalid_after",
    });
  });

  it("plans several operations in base coordinates, refuses overlaps and verifies once", () => {
    const html = page("<p>alpha beta gamma</p><p>delta</p>");
    const planned = planHtml(html, [
      edit(html, "alpha", "one"),
      edit(html, "gamma", "three"),
      edit(html, "delta", "four"),
    ]);
    expect(planned.listed).toEqual([]);
    expect(rawBody(planned.source as string)).toBe(
      rawBody(html).replace("alpha", "one").replace("gamma", "three").replace("delta", "four"),
    );
    const clash = planHtml(html, [edit(html, "alpha beta", "x"), edit(html, "beta gamma", "y")]);
    expect(clash.applied).toEqual([]);
    expect(clash.listed.map((item) => item.reason)).toEqual(["overlap", "overlap"]);
    expect(planHtml(html, [edit(html, "Nope", "x")]).listed[0]?.reason).toBe("stale");
  });
});
