import { contentHash } from "@portifact/anchors";
import { describe, expect, it } from "vitest";
import { escapeHtml, resolveHtmlEdit } from "../src/html-resolver.ts";
import { pageText, parseDocument, skeleton } from "../src/page.ts";
import { HOSTILE_AFTERS } from "./corpus.ts";

/**
 * A page of the corpus: its file and what its own script does to the DOM once loaded. happy-dom
 * does not run the scripts here (`parseDocument` never does), so each page's script is also
 * written as a function, and the live text the reviewer saw is the text after it ran.
 */
interface Fixture {
  name: string;
  html: string;
  script?: (document: Document) => void;
}

const page = (body: string, head = "") =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Report</title>${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

const FIXTURES: Fixture[] = [
  {
    name: "static",
    html: page("<h1>Quarterly report</h1>\n<p>The budget grew by\n  ten percent.</p>"),
  },
  { name: "entities", html: page("<p>Fish &amp; chips &mdash; daily.</p>") },
  {
    name: "inline markup",
    html: page('<p>Read <a href="/terms">the terms</a> and <strong>sign</strong> here.</p>'),
  },
  {
    name: "text also in an attribute",
    html: page('<p title="Quarterly report">Quarterly report</p>'),
  },
  {
    name: "text also in a script string",
    html: page(
      '<p id="t">Quarterly report</p>\n<script>const title = "Quarterly report";</script>',
    ),
  },
  {
    name: "script adds text",
    html: page(
      '<p id="t">Static line.</p>\n<script>document.body.append("Drawn by script.")</script>',
    ),
    script: (document) => {
      document.body.append("Drawn by script.");
    },
  },
  {
    name: "script changes text present in the file",
    html: page(
      '<p id="t">Loading</p>\n<script>document.getElementById("t").textContent = "Loaded"</script>',
    ),
    script: (document) => {
      (document.getElementById("t") as Element).textContent = "Loaded";
    },
  },
  {
    name: "script that leaves text alone",
    html: page('<p id="t">Static line.</p>\n<script>document.body.dataset.ready = "1"</script>'),
    script: (document) => {
      document.body.dataset.ready = "1";
    },
  },
  { name: "repeated text", html: page("<p>Total</p>\n<p>Total</p>") },
  { name: "comment", html: page("<p>Visible words</p>\n<!-- Visible words -->") },
];

async function live(fixture: Fixture): Promise<{ text: string; hash: string }> {
  const document = parseDocument(fixture.html);
  fixture.script?.(document);
  const text = pageText(document.body);
  return { text, hash: await contentHash(text) };
}

async function edit(fixture: Fixture, before: string, after: string, occurrence = 0) {
  const { text, hash } = await live(fixture);
  let at = -1;
  for (let i = 0; i <= occurrence; i++) at = text.indexOf(before, at + 1);
  const start = Array.from(text.slice(0, at)).length;
  return resolveHtmlEdit(
    fixture.html,
    { start, end: start + Array.from(before).length, before, after },
    hash,
  );
}

const fixture = (name: string) => FIXTURES.find((item) => item.name === name) as Fixture;

describe("static HTML resolver", () => {
  it("applies an edit to static text, escaped, and nothing else changes", async () => {
    const result = await edit(fixture("static"), "ten percent", "<b>12%</b> & more");
    expect(result).toMatchObject({ status: "certain" });
    const next = (result as { source: string }).source;
    expect(next).toContain("grew by\n  &lt;b&gt;12%&lt;/b&gt; &amp; more.");
    expect(skeleton(parseDocument(next).documentElement)).toBe(
      skeleton(parseDocument(fixture("static").html).documentElement),
    );
  });

  it("edits inside inline markup but not across it", async () => {
    expect(await edit(fixture("inline markup"), "terms", "rules")).toMatchObject({
      status: "certain",
    });
    expect(await edit(fixture("inline markup"), "the terms and sign", "these")).toMatchObject({
      status: "uncertain",
    });
  });

  it("refuses text a script wrote or changed, and allows pages whose scripts leave text alone", async () => {
    expect(await edit(fixture("script adds text"), "Static", "Fixed")).toEqual({
      status: "uncertain",
      reason: "script_text",
    });
    expect(
      await edit(fixture("script changes text present in the file"), "Loaded", "Done"),
    ).toEqual({
      status: "uncertain",
      reason: "script_text",
    });
    expect(await edit(fixture("script that leaves text alone"), "Static", "Fixed")).toMatchObject({
      status: "certain",
    });
  });

  it("refuses text that also occurs in an attribute, a script, a comment or twice", async () => {
    // The visible text is the whole page text, so no context can tell the copies apart.
    for (const name of ["text also in an attribute", "text also in a script string", "comment"]) {
      const before = name === "comment" ? "Visible words" : "Quarterly report";
      expect(await edit(fixture(name), before, "Annual review")).toEqual({
        status: "uncertain",
        reason: "not_found",
      });
    }
    expect(await edit(fixture("repeated text"), "Total", "Sum")).toEqual({
      status: "uncertain",
      reason: "not_found",
    });
    // With a unique context the copy in the attribute stays as it was.
    const attribute: Fixture = {
      name: "x",
      html: page('<p title="report">The report is late.</p>'),
    };
    const result = await edit(attribute, "report", "memo");
    expect(result).toMatchObject({ status: "certain" });
    expect((result as { source: string }).source).toContain(
      '<p title="report">The memo is late.</p>',
    );
  });

  it("refuses entities it cannot spell, and edits beside them", async () => {
    expect(await edit(fixture("entities"), "&", "and")).toMatchObject({ status: "uncertain" });
    expect(await edit(fixture("entities"), "daily", "weekly")).toMatchObject({ status: "certain" });
  });

  it("never lets hostile after-text add markup", async () => {
    let certain = 0;
    for (const after of HOSTILE_AFTERS) {
      const result = await edit(fixture("static"), "ten percent", after);
      if (result.status !== "certain") continue;
      certain++;
      const parsed = parseDocument(result.source);
      expect(skeleton(parsed.documentElement)).toBe(
        skeleton(parseDocument(fixture("static").html).documentElement),
      );
      expect(pageText(parsed.body)).toContain(after);
    }
    expect(certain).toBe(HOSTILE_AFTERS.length);
    expect(escapeHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
  });

  it("refuses stale and invalid edits", async () => {
    const { hash } = await live(fixture("static"));
    expect(
      await resolveHtmlEdit(
        fixture("static").html,
        { start: 0, end: 3, before: "xyz", after: "a" },
        hash,
      ),
    ).toEqual({
      status: "uncertain",
      reason: "stale",
    });
    expect(
      await resolveHtmlEdit(
        fixture("static").html,
        { start: 0, end: 3, before: "Qua", after: "a\tb" },
        hash,
      ),
    ).toEqual({
      status: "uncertain",
      reason: "invalid_after",
    });
  });
});
