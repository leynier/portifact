import { type EditOperation, STYLE_PROPERTIES, StyleOperation } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { elementTargetOf, parseDocument, RENDERER } from "../testing/suggestions/pages.ts";
import { previewOfEdit } from "./preview.ts";
import { locateElementEdits } from "./preview-edits.ts";
import { newWork } from "./work.ts";

const PAGE =
  '<!doctype html><html><head><style>p{color:blue!important}</style></head><body><h1 id="title">Report</h1><p class="lead" style="font-weight:bold;color:green">First paragraph</p><p>Second paragraph</p><script>document.body.append("x")</script></body></html>';

async function styleOf(
  kind: "html" | "markdown" | "text",
  source: string,
  selector: string,
  changes: { property: string; before: string | null; after: string }[],
): Promise<EditOperation> {
  const target = await elementTargetOf(kind, source, selector);
  return StyleOperation.parse({ kind: "style", target, changes });
}

function preview(kind: "html" | "markdown" | "text", source: string, operations: EditOperation[]) {
  return previewOfEdit({ kind, base: source, shown: source, operations, renderer: RENDERER });
}

/** The `style` attribute of the element `selector` finds in a built preview. */
function styleIn(document: string, selector: string): string | null {
  return parseDocument(document).querySelector(selector)?.getAttribute("style") ?? null;
}

describe("style operations on built previews", () => {
  it("sets each change once on the element, keeping its other declarations", async () => {
    const op = await styleOf("html", PAGE, "p.lead", [
      { property: "color", before: null, after: "red" },
      { property: "font-size", before: null, after: "18px" },
    ]);
    const built = preview("html", PAGE, [op]);
    expect(built.state).toBe("ready");
    if (built.state !== "ready") return;
    expect(styleIn(built.document, "p.lead")).toBe(
      "font-weight:bold;color:red!important;font-size:18px!important",
    );
    // Only the picked element changes; the page's own stylesheet is kept as it was.
    expect(styleIn(built.document, "h1")).toBeNull();
    expect(built.document).toContain("<style>p{color:blue!important}</style>");
    expect(built.document).not.toContain("<script");
  });

  it("finds elements in a Markdown document's stored page", async () => {
    const source = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
    const op = await styleOf("markdown", source, "main > p:nth-of-type(2)", [
      { property: "text-align", before: null, after: "center" },
    ]);
    const built = preview("markdown", source, [op]);
    expect(built.state).toBe("ready");
    if (built.state !== "ready") return;
    const document = parseDocument(built.document);
    const paragraphs = Array.from(document.querySelectorAll("p"));
    expect(paragraphs.map((p) => p.getAttribute("style"))).toEqual([
      null,
      "text-align:center!important",
    ]);
  });

  it("writes exactly one declaration for every allowed value of every property", async () => {
    const samples: Record<string, string[]> = {
      color: ["#abc", "#a1b2c3", "rgb(1, 2, 3)", "rgb(255 0 9)", "navy"],
      "background-color": ["white", "#000"],
      "font-size": ["8px", "96px"],
      "font-weight": ["normal", "bold", "100", "900"],
      "font-style": ["italic", "normal"],
      "text-align": ["left", "right", "center", "justify", "start", "end"],
      "text-decoration-line": ["none", "underline", "line-through", "overline"],
      "text-transform": ["none", "uppercase", "lowercase", "capitalize"],
      "letter-spacing": ["normal", "0px", "10px"],
      "border-radius": ["0px", "64px"],
    };
    expect(Object.keys(samples).sort()).toEqual(Object.keys(STYLE_PROPERTIES).sort());
    const page = "<!doctype html><html><head></head><body><p>Text</p></body></html>";
    for (const [property, values] of Object.entries(samples)) {
      for (const value of values) {
        const op = await styleOf("html", page, "p", [{ property, before: null, after: value }]);
        const built = preview("html", page, [op]);
        if (built.state !== "ready") throw new Error(`${property}: ${value}`);
        expect(styleIn(built.document, "p"), `${property}: ${value}`).toBe(
          `${property}:${value}!important`,
        );
      }
    }
  });

  it("gives no preview when an element is not on the stored page exactly", async () => {
    // Picked on the live page after its script changed the paragraph's text.
    const live = PAGE.replace("Second paragraph", "Second paragraph, drawn later");
    const op = await styleOf("html", live, "body > p:nth-of-type(2)", [
      { property: "color", before: null, after: "red" },
    ]);
    expect(preview("html", PAGE, [op])).toEqual({
      state: "unavailable",
      reason: "element_not_found",
    });
    // An element only a script added is nowhere in the file.
    const drawn = PAGE.replace("</body>", '<aside id="late">Late</aside></body>');
    const late = await styleOf("html", drawn, "#late", [
      { property: "color", before: null, after: "red" },
    ]);
    expect(preview("html", PAGE, [late])).toEqual({
      state: "unavailable",
      reason: "element_not_found",
    });
  });

  it("gives no preview when the element's own style cannot be read", async () => {
    const deep = `<!doctype html><html><head></head><body><p style="color:${"(".repeat(40)}">Text</p></body></html>`;
    const op = await styleOf("html", deep, "p", [
      { property: "color", before: null, after: "red" },
    ]);
    expect(preview("html", deep, [op])).toEqual({
      state: "unavailable",
      reason: "css_too_complex",
    });
  });

  it("never writes a value outside the grammar, whatever reaches it", async () => {
    const page = "<!doctype html><html><head></head><body><p>Text</p></body></html>";
    const target = await elementTargetOf("html", page, "p");
    // Built by hand, past the schema: the locator still keeps only allowed values.
    const hostile = {
      kind: "style",
      target,
      changes: [
        { property: "color", before: null, after: "red;background:url(x)" },
        { property: "position", before: null, after: "fixed" },
        { property: "color", before: null, after: "teal" },
      ],
    } as unknown as EditOperation;
    const located = locateElementEdits(page, [hostile], newWork());
    expect(located).toEqual([
      {
        kind: "style",
        path: expect.any(Array),
        declarations: [{ property: "color", value: "teal" }],
      },
    ]);
  });

  it("previews text and style together, locating elements on the stored file", async () => {
    const op = await styleOf("html", PAGE, "h1", [
      { property: "font-style", before: null, after: "italic" },
    ]);
    const shown = PAGE.replace("Report", "Annual report");
    const built = previewOfEdit({
      kind: "html",
      base: PAGE,
      shown,
      operations: [op],
      renderer: RENDERER,
    });
    expect(built.state).toBe("ready");
    if (built.state !== "ready") return;
    expect(built.document).toContain(
      '<h1 id="title" style="font-style:italic!important">Annual report</h1>',
    );
  });

  it("counts one parse of the stored page and one index for any number of operations", async () => {
    const ops = await Promise.all(
      ["h1", "p.lead", "body > p:nth-of-type(2)"].map((selector) =>
        styleOf("html", PAGE, selector, [{ property: "color", before: null, after: "red" }]),
      ),
    );
    const work = newWork();
    const built = previewOfEdit({
      kind: "html",
      base: PAGE,
      shown: PAGE,
      operations: ops,
      renderer: RENDERER,
      work,
    });
    expect(built.state).toBe("ready");
    expect(work).toMatchObject({ parses: 2, indexes: 1 });
  });
});
