// Edge cases of the planners, the preview and the proofs that the main tests do not reach.
import { describe, expect, it } from "vitest";
import { closure } from "../src/closure.ts";
import { planHtml, resolveHtmlEdit } from "../src/html-resolver.ts";
import { pageText, parseDocument } from "../src/page.ts";
import { buildPlan, previewOf, RENDERER } from "../src/plan.ts";
import { buildPreview } from "../src/preview.ts";
import { carry } from "../src/relocate.ts";
import { planText } from "../src/text-resolver.ts";

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title><style>p{color:red}</style></head><body>${body}</body></html>`;

function edit(html: string, before: string, after: string) {
  const text = pageText(parseDocument(html).body);
  const start = Array.from(text.slice(0, text.indexOf(before))).length;
  return { start, end: start + Array.from(before).length, before, after };
}

describe("HTML planner edges", () => {
  it("maps text after a CRLF line break", () => {
    const html = page("<p>first\r\nsecond word</p>");
    expect(resolveHtmlEdit(html, edit(html, "word", "term"))).toMatchObject({
      status: "certain",
      source: expect.stringContaining("first\r\nsecond term"),
    });
  });

  it("lists operations over the plan's limit and invalid ones", () => {
    const html = page("<p>alpha</p>");
    const operations = Array.from({ length: 101 }, () => edit(html, "alpha", "beta"));
    const planned = planHtml(html, operations);
    expect(planned.listed.filter((item) => item.reason === "too_large")).toHaveLength(1);
    expect(planHtml(html, [edit(html, "alpha", "a\nb")]).listed[0]?.reason).toBe("invalid_after");
    expect(planHtml(html, [edit(html, "alpha", "alpha")]).listed[0]?.reason).toBe("invalid_after");
  });

  it("refuses a file without a body to edit and a file over the size limit", () => {
    expect(
      planHtml(`${page("<p>x</p>")}${"<!-- x -->".repeat(110_000)}`, [
        { start: 0, end: 1, before: "x", after: "y" },
      ]).listed[0]?.reason,
    ).toBe("too_large");
  });
});

describe("previews keep the page's own styles, inert", () => {
  it("keeps head styles under the policy", () => {
    const preview = buildPreview("html", page("<p>x</p>"));
    expect(preview).toContain("<style>p{color:red}</style>");
    expect(preview).not.toContain("<title>");
  });

  it("previews a plan on an HTML page", () => {
    const html = page("<p>alpha beta</p>");
    const built = buildPlan({
      binding: {
        artifactId: "a",
        versionId: "v",
        path: "index.html",
        renderer: RENDERER,
        suggestionId: "s",
        suggestionRevision: 1,
      },
      provenance: { submittedBy: "r", acceptedBy: "o" },
      kind: "html",
      source: html,
      edits: [edit(html, "alpha", "gamma")],
    });
    const preview = previewOf(built);
    expect(preview.state === "ready" && preview.document).toContain("<p>gamma beta</p>");
  });
});

describe("proofs on text documents and HTML pages", () => {
  it("carries a text document's suggestion and closes an HTML item", () => {
    const text = "alpha\nbeta gamma";
    const planned = planText(text, [{ start: 6, end: 10, before: "beta", after: "BETA" }]);
    const proof = planned.applied[0]?.proof;
    if (!proof) throw new Error("not planned");
    expect(
      carry(
        "text",
        text,
        `intro\n${text}`,
        { start: 6, end: 10, before: "beta", after: "BETA" },
        proof,
      ),
    ).toMatchObject({
      status: "carried",
      edit: { start: 12, end: 16 },
    });
    const html = page("<p>The budget grew in March.</p>");
    const htmlProof = planHtml(html, [edit(html, "grew", "fell")]).applied[0]?.proof;
    if (!htmlProof) throw new Error("not planned");
    expect(
      closure(htmlProof, "html", page("<p>The budget fell in March.</p>"), "v2"),
    ).toMatchObject({ state: "closed" });
    expect(
      closure(htmlProof, "html", page("<p>The <em>budget</em> fell in March.</p>"), "v2").state,
    ).toBe("open");
  });
});

describe("source mapping edges", () => {
  it("reads a bare ampersand and a lone carriage return literally", () => {
    const html = page("<p>salt & pepper\rand more</p>");
    expect(resolveHtmlEdit(html, edit(html, "pepper", "sugar"))).toMatchObject({
      status: "certain",
      source: expect.stringContaining("salt & sugar\rand more"),
    });
  });

  it("refuses a reference cut in two by the change", () => {
    const html = page("<p>caf&#233;s</p>");
    expect(resolveHtmlEdit(html, edit(html, "és", "e")).status).toBe("certain");
    const split = page("<p>x&#x1F600;y</p>");
    const text = pageText(parseDocument(split).body);
    // The emoji is one code point but two UTF-16 units from one reference: it maps as a whole.
    expect(
      resolveHtmlEdit(split, {
        start: 1,
        end: 2,
        before: Array.from(text)[1] as string,
        after: "z",
      }).status,
    ).toBe("certain");
  });
});

describe("the parse5 adapter", () => {
  it("presents comments, elements and text with the DOM surface anchors need", async () => {
    const { adapt, find, parseHtml } = await import("../src/html-dom.ts");
    const document = parseHtml("<!doctype html><body><!-- c --><p id=a>t</p></body>").document;
    const body = adapt(find(document, "body") as never);
    const [comment, paragraph] = body.childNodes;
    expect(comment?.nodeType).toBe(8);
    expect(paragraph?.nodeType).toBe(1);
    const element = paragraph as unknown as {
      tagName: string;
      getAttribute(n: string): string | null;
      data: string;
      querySelectorAll(): ArrayLike<unknown>;
    };
    expect(element.tagName).toBe("P");
    expect(element.getAttribute("id")).toBe("a");
    expect(element.data).toBe("");
    expect(element.querySelectorAll()).toHaveLength(0);
    expect(adapt(document as never).nodeType).toBe(9);
  });
});

describe("subset limits", () => {
  it("refuses head-only elements in the body, bare meta and too many nodes", async () => {
    const { parseHtml } = await import("../src/html-dom.ts");
    const { subsetRefusal } = await import("../src/html-subset.ts");
    const refusal = (html: string) => subsetRefusal(html, parseHtml(html));
    expect(refusal(page("<p>x</p><style>p{}</style>"))).toBe("head_only");
    expect(refusal(page("<p>x</p>").replace("<title>", '<meta content="x"><title>'))).toBe(
      "attribute",
    );
    expect(refusal(page("<i></i>".repeat(50_001)))).toBe("too_large");
  });
});

describe("plans for text documents and their confirmation", () => {
  it("plans with a verified baseline and refuses a plan without its bytes", async () => {
    const { storedRenderingOf, confirmPlan } = await import("../src/plan.ts");
    const source = "alpha beta";
    const built = buildPlan({
      binding: {
        artifactId: "a",
        versionId: "v",
        path: "notes.txt",
        renderer: RENDERER,
        suggestionId: "s",
        suggestionRevision: 1,
      },
      provenance: { submittedBy: "r", acceptedBy: "o" },
      kind: "text",
      source,
      edits: [{ start: 0, end: 5, before: "alpha", after: "gamma" }],
      stored: storedRenderingOf("text", source),
    });
    expect(built.newSource).toBe("gamma beta");
    expect(built.output?.blockMapSha256).toBeNull();
    expect(confirmPlan(built, built.digest, built.binding)).toBe(true);
    const { newSource: _bytes, ...withoutBytes } = built;
    expect(confirmPlan(withoutBytes, built.digest, built.binding)).toBe(false);
  });
});

describe("the happy-dom comparison", () => {
  it("refuses different node counts and a change that does not match", async () => {
    const { onlyChanged } = await import("../src/locate.ts");
    const a = parseDocument("<!doctype html><body><p>a</p></body>").body;
    const b = parseDocument("<!doctype html><body><p>a<br>b</p></body>").body;
    expect(onlyChanged(a, b, [])).toBe(false);
    const c = parseDocument("<!doctype html><body><p>abc</p></body>").body;
    const d = parseDocument("<!doctype html><body><p>axc</p></body>").body;
    expect(onlyChanged(c, d, [{ node: 0, start: 1, end: 2, deleted: "z", inserted: "x" }])).toBe(
      false,
    );
    expect(onlyChanged(c, d, [{ node: 0, start: 1, end: 2, deleted: "b", inserted: "x" }])).toBe(
      true,
    );
  });
});
