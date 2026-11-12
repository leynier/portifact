// The counterexamples of the design review of pull request #247, one test each, written against
// the spike as it stood so they fail first. Numbers are the review's findings.
import { contentHash } from "@portifact/anchors";
import { ANCHOR_SCHEMA_VERSION, type AnnotationTarget } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { resolveHtmlEdit } from "../src/html-resolver.ts";
import { renderPage, resolveMarkdownEdit } from "../src/markdown-resolver.ts";
import { Edit } from "../src/operations.ts";
import { pageText, parseDocument } from "../src/page.ts";
import { checkStyle } from "../src/style.ts";
import { resolveTextEdit } from "../src/text-resolver.ts";

const at = (text: string, needle: string, from = 0) =>
  Array.from(text.slice(0, text.indexOf(needle, from))).length;

function mdEdit(source: string, before: string, after: string, occurrence = 0) {
  const text = renderPage(source).text;
  let index = -1;
  for (let i = 0; i <= occurrence; i++) index = text.indexOf(before, index + 1);
  const start = Array.from(text.slice(0, index)).length;
  return resolveMarkdownEdit(source, {
    start,
    end: start + Array.from(before).length,
    before,
    after,
  });
}

describe("finding 3: a page whose script rewrites text never earns automatic application", () => {
  it("refuses the review's counterexample even with the stored page's hash", async () => {
    const html =
      '<!doctype html><p>Pay $10</p><script>document.querySelector("p").textContent="Tip $10"</script>';
    const text = pageText(parseDocument(html).body);
    const start = at(text, "$10");
    const result = await resolveHtmlEdit(
      html,
      { start, end: start + 3, before: "$10", after: "$20" },
      await contentHash(text),
    );
    expect(result.status).toBe("uncertain");
  });
});

describe("finding 5: heading IDs are part of the page", () => {
  it("refuses an edit that changes the edited heading's ID", () => {
    expect(mdEdit("# needle\n\n[go](#needle)", "needle", "fixed").status).toBe("uncertain");
  });

  it("refuses an edit that changes another heading's ID", () => {
    expect(mdEdit("# one\n\n# two\n\n[go](#two)", "one", "two").status).toBe("uncertain");
  });
});

describe("finding 6: whitespace is compared exactly", () => {
  it("refuses joining lines of a text document", () => {
    expect(
      resolveTextEdit("alpha\n    beta", {
        start: 0,
        end: 10,
        before: "alpha beta",
        after: "ALPHA BETA",
      }).status,
    ).toBe("uncertain");
  });

  it("refuses joining lines of fenced and indented code", () => {
    expect(mdEdit("```\nalpha\n    beta\n```", "alpha beta", "ALPHA BETA").status).toBe(
      "uncertain",
    );
    expect(mdEdit("    alpha\n    beta", "alpha beta", "ALPHA BETA").status).toBe("uncertain");
  });

  it("refuses collapsing spaces in a code span", () => {
    expect(mdEdit("`alpha   beta`", "alpha beta", "ALPHA BETA").status).toBe("uncertain");
  });

  it("refuses joining lines in HTML pre and pre-wrap", async () => {
    for (const body of [
      "<pre>alpha\n    beta</pre>",
      '<p style="white-space: pre-wrap">alpha\n    beta</p>',
    ]) {
      const html = `<!doctype html>${body}`;
      const text = pageText(parseDocument(html).body);
      const result = await resolveHtmlEdit(
        html,
        { start: 0, end: 10, before: "alpha beta", after: "ALPHA BETA" },
        await contentHash(text),
      );
      expect(result.status, body).toBe("uncertain");
    }
  });
});

describe("finding 8: the first style delivery's narrower allowlist", () => {
  it("refuses zero, near-zero, relative and transparent values and the dropped properties", () => {
    for (const [property, value] of [
      ["font-size", "0px"],
      ["font-size", "0em"],
      ["font-size", "0%"],
      ["font-size", "00"],
      ["font-size", "0.001px"],
      ["font-size", "6em"],
      ["color", "transparent"],
      ["color", "rgba(0,0,0,0)"],
      ["color", "#0000"],
      ["color", "rgb(1 2,3)"],
      ["line-height", "1.5"],
      ["margin-top", "4px"],
      ["padding-left", "4px"],
    ] as const) {
      expect(checkStyle(property, value), `${property}: ${value}`).not.toBe(true);
    }
  });
});

const element = (path = "index.html", route?: string): AnnotationTarget => ({
  schema: ANCHOR_SCHEMA_VERSION,
  path,
  ...(route ? { route } : {}),
  anchor: { kind: "element", selectors: ["#x"], tagName: "p", fingerprint: "x" },
});

describe("finding 20: one edit is on one page and route", () => {
  it("refuses operations on different routes of one file", () => {
    expect(
      Edit.safeParse({
        operations: [
          { kind: "structure", action: "remove", target: element("index.html", "/a") },
          { kind: "structure", action: "remove", target: element("index.html", "/b") },
        ],
      }).success,
    ).toBe(false);
  });

  it("refuses a move whose destination is in another file", () => {
    expect(
      Edit.safeParse({
        operations: [
          {
            kind: "structure",
            action: "move",
            target: element("index.html"),
            destination: { target: element("other.html"), place: "after" },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("finding 21: deletions resolve", () => {
  it("applies deleting a word with its space", () => {
    expect(mdEdit("a needle b", "a needle b", "a b").status).toBe("certain");
    expect(
      resolveTextEdit("a needle b", { start: 0, end: 10, before: "a needle b", after: "a b" })
        .status,
    ).toBe("certain");
  });
});

import { bridgeEnvelope } from "@portifact/bridge";
import { EditSession } from "../src/edit-session.ts";

describe("findings 1, 2 and 7: nothing typed reaches the frame, and frame geometry is ignored while editing", () => {
  const frame = { name: "frame" };
  const NONCE = "abcdefghijklmnopqrstuv";
  const origin = "https://k7d2qm4xab.portifact.dev";
  const selection = (exact: string) =>
    bridgeEnvelope(NONCE, {
      type: "selection",
      target: {
        schema: ANCHOR_SCHEMA_VERSION,
        path: "index.html",
        anchor: {
          kind: "text",
          quote: { exact, prefix: "", suffix: "" },
          position: { start: 0, end: exact.length },
        },
      },
      rect: { x: 10, y: 10, width: 50, height: 10 },
    });

  it("keeps the editor where the viewer placed it and posts no typed text to the frame", () => {
    const session = new EditSession({ origin, source: frame, nonce: NONCE }, () => {});
    session.start("text");
    session.receive({ data: selection("Hello"), origin, source: frame });
    const placed = session.placement;
    expect(placed).toEqual({ x: 10, y: 10, width: 50, height: 10 });
    session.receive({
      data: bridgeEnvelope(NONCE, {
        type: "selection-rect",
        rect: { x: 300, y: 300, width: 5, height: 5 },
      }),
      origin,
      source: frame,
    });
    session.type("private draft");
    expect(session.placement).toEqual(placed);
    expect(JSON.stringify(session.framePosts)).not.toContain("private draft");
  });
});
