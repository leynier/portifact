import { type EditOperation, StructureOperation } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { elementTargetOf, parseDocument, RENDERER } from "../testing/suggestions/pages.ts";
import { previewOfEdit } from "./preview.ts";
import { newWork } from "./work.ts";

const PAGE =
  '<!doctype html><html><head></head><body><h1 id="title">Report</h1><p id="one">First</p><p id="two">Second</p><section id="box"><p id="inner">Inner</p></section><script>1</script></body></html>';

async function structure(
  action: "move" | "duplicate" | "remove",
  selector: string,
  destination?: { selector: string; place: "before" | "after" },
  source = PAGE,
  kind: "html" | "markdown" = "html",
): Promise<EditOperation> {
  const target = await elementTargetOf(kind, source, selector);
  return StructureOperation.parse({
    kind: "structure",
    action,
    target,
    ...(destination
      ? {
          destination: {
            target: await elementTargetOf(kind, source, destination.selector),
            place: destination.place,
          },
        }
      : {}),
  });
}

function preview(operations: EditOperation[], source = PAGE, kind: "html" | "markdown" = "html") {
  return previewOfEdit({ kind, base: source, shown: source, operations, renderer: RENDERER });
}

/** The body's elements in a built preview, by their text, in order. */
function order(document: string): string[] {
  return Array.from(parseDocument(document).body.querySelectorAll("h1, p")).map(
    (element) => element.textContent ?? "",
  );
}

function ready(result: ReturnType<typeof preview>): string {
  if (result.state !== "ready") throw new Error(`no preview: ${result.reason}`);
  return result.document;
}

describe("structure operations on built previews", () => {
  it("moves an element before or after another one", async () => {
    expect(
      order(
        ready(preview([await structure("move", "#two", { selector: "#title", place: "before" })])),
      ),
    ).toEqual(["Second", "Report", "First", "Inner"]);
    expect(
      order(
        ready(preview([await structure("move", "#title", { selector: "#inner", place: "after" })])),
      ),
    ).toEqual(["First", "Second", "Inner", "Report"]);
    // Moved into the section, next to its paragraph.
    const moved = parseDocument(
      ready(preview([await structure("move", "#one", { selector: "#inner", place: "before" })])),
    );
    expect(Array.from(moved.querySelectorAll("#box > p")).map((p) => p.id)).toEqual([
      "one",
      "inner",
    ]);
  });

  it("duplicates an element right after itself and removes one", async () => {
    expect(order(ready(preview([await structure("duplicate", "#one")])))).toEqual([
      "Report",
      "First",
      "First",
      "Second",
      "Inner",
    ]);
    expect(order(ready(preview([await structure("remove", "#box")])))).toEqual([
      "Report",
      "First",
      "Second",
    ]);
  });

  it("finds every element before any operation runs, so later ones keep their targets", async () => {
    const ops = [
      await structure("remove", "#title"),
      await structure("move", "#two", { selector: "#one", place: "before" }),
      await structure("duplicate", "#inner"),
    ];
    expect(order(ready(preview(ops)))).toEqual(["Second", "First", "Inner", "Inner"]);
  });

  it("refuses a move into the element itself, or next to an element already removed", async () => {
    expect(
      preview([await structure("move", "#box", { selector: "#inner", place: "after" })]),
    ).toEqual({ state: "unavailable", reason: "structure_conflict" });
    const ops = [
      await structure("remove", "#title"),
      await structure("move", "#two", { selector: "#title", place: "after" }),
    ];
    expect(preview(ops)).toEqual({ state: "unavailable", reason: "structure_conflict" });
    // Removing twice: the second has nothing left to remove.
    expect(preview([await structure("remove", "#one"), await structure("remove", "#one")])).toEqual(
      { state: "unavailable", reason: "structure_conflict" },
    );
  });

  it("gives no preview when an element or a destination is not on the stored page", async () => {
    const drawn = PAGE.replace("</body>", '<aside id="late">Late</aside></body>');
    expect(preview([await structure("remove", "#late", undefined, drawn)])).toEqual({
      state: "unavailable",
      reason: "element_not_found",
    });
    expect(
      preview([await structure("move", "#one", { selector: "#late", place: "after" }, drawn)]),
    ).toEqual({ state: "unavailable", reason: "element_not_found" });
  });

  it("moves a paragraph of a Markdown document", async () => {
    const source = "# Title\n\nFirst.\n\nSecond.\n";
    const op = await structure(
      "move",
      "main > p:nth-of-type(2)",
      { selector: "main > h1", place: "before" },
      source,
      "markdown",
    );
    expect(order(ready(preview([op], source, "markdown")))).toEqual(["Second.", "Title", "First."]);
  });

  it("writes a copy as passively as the page it copies, with a style on the same edit", async () => {
    const page =
      '<!doctype html><html><head></head><body><p id="x" onclick="1" style="color:green"><a href="https://e.example">Pay</a></p></body></html>';
    const target = await elementTargetOf("html", page, "#x");
    const ops: EditOperation[] = [
      { kind: "style", target, changes: [{ property: "color", before: null, after: "red" }] },
      { kind: "structure", action: "duplicate", target },
    ];
    const document = ready(preview(ops, page));
    expect(document).not.toMatch(/onclick|href/);
    // The style was set before the copy was made, so both show it.
    expect(document.match(/style="color:red!important"/g)).toHaveLength(2);
  });

  it("counts one parse of the stored page and one index for structure too", async () => {
    const work = newWork();
    const op = await structure("move", "#two", { selector: "#title", place: "before" });
    previewOfEdit({
      kind: "html",
      base: PAGE,
      shown: PAGE,
      operations: [op],
      renderer: RENDERER,
      work,
    });
    expect(work).toMatchObject({ parses: 2, indexes: 1 });
  });
});

describe("structure previews stay bounded and connected (review of pull request #288)", () => {
  /** 16 nested sections, each with an ID, innermost holding text. */
  const NESTED = `<!doctype html><html><head></head><body>${Array.from(
    { length: 16 },
    (_, i) => `<section id="s${i + 1}">`,
  ).join("")}x${"</section>".repeat(16)}</body></html>`;

  it("refuses duplicates that would copy earlier copies without bound (P1)", async () => {
    const ops: EditOperation[] = [];
    for (let i = 16; i >= 1; i--) {
      ops.push(await structure("duplicate", `#s${i}`, undefined, NESTED));
    }
    const started = Date.now();
    expect(preview(ops, NESTED)).toEqual({ state: "unavailable", reason: "preview_too_large" });
    // Refused before the copies are made, not after building 131,070 elements.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("still duplicates within the copy budget", async () => {
    const ops: EditOperation[] = [];
    for (let i = 16; i >= 13; i--) {
      ops.push(await structure("duplicate", `#s${i}`, undefined, NESTED));
    }
    const built = ready(preview(ops, NESTED));
    expect(parseDocument(built).querySelectorAll("section").length).toBeGreaterThan(16);
  });

  it("refuses a move next to an element inside a removed subtree (P2)", async () => {
    const ops = [
      await structure("remove", "#box"),
      await structure("move", "#two", { selector: "#inner", place: "after" }),
    ];
    expect(preview(ops)).toEqual({ state: "unavailable", reason: "structure_conflict" });
  });

  it("refuses to move or duplicate an element already removed, never bringing it back (P2)", async () => {
    expect(
      preview([
        await structure("remove", "#one"),
        await structure("move", "#one", { selector: "#title", place: "before" }),
      ]),
    ).toEqual({ state: "unavailable", reason: "structure_conflict" });
    expect(
      preview([await structure("remove", "#box"), await structure("duplicate", "#inner")]),
    ).toEqual({ state: "unavailable", reason: "structure_conflict" });
    expect(
      preview([await structure("remove", "#box"), await structure("remove", "#inner")]),
    ).toEqual({ state: "unavailable", reason: "structure_conflict" });
  });
});
