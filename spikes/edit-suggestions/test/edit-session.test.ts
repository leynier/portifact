import { bridgeEnvelope, type Expectation } from "@portifact/bridge";
import { ANCHOR_SCHEMA_VERSION, type AnnotationTarget } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { type Confirmation, EditSession } from "../src/edit-session.ts";
import type { Edit } from "../src/operations.ts";
import { pick, random } from "./corpus.ts";

const APP = "https://k7d2qm4xab.portifact.dev";
const NONCE = "abcdefghijklmnopqrstuv";
/** The frame's window as the viewer sees it. The page's own scripts post from the same window. */
const frame = { name: "frame" };
const expected: Expectation = { origin: APP, source: frame, nonce: NONCE };

const text = (exact: string, start = 0): AnnotationTarget => ({
  schema: ANCHOR_SCHEMA_VERSION,
  path: "index.html",
  anchor: {
    kind: "text",
    quote: { exact, prefix: "", suffix: "" },
    position: { start, end: start + Array.from(exact).length },
  },
});
const element = (fingerprint: string): AnnotationTarget => ({
  schema: ANCHOR_SCHEMA_VERSION,
  path: "index.html",
  anchor: { kind: "element", selectors: ["#x"], tagName: "p", fingerprint },
});

/** Everything a page can post with the nonce it overheard, including messages no schema has. */
function forged(rand: () => number): unknown {
  return pick(rand, [
    () =>
      bridgeEnvelope(NONCE, {
        type: "selection",
        target: text(pick(rand, ["Pay to IBAN X", "Approved", "Hello"]), 3),
      }),
    () => bridgeEnvelope(NONCE, { type: "selection", target: null }),
    () => bridgeEnvelope(NONCE, { type: "element", target: element("Sign in") }),
    () =>
      bridgeEnvelope(NONCE, {
        type: "selection-rect",
        rect: { x: 0, y: 0, width: 9_999, height: 9_999 },
      }),
    () => bridgeEnvelope(NONCE, { type: "pick-ended" }),
    () => bridgeEnvelope(NONCE, { type: "pong" }),
    () => ({ ...bridgeEnvelope(NONCE, { type: "pong" }), type: "edit", after: "Pay to IBAN X" }),
    () => ({ ...bridgeEnvelope(NONCE, { type: "pong" }), type: "confirm" }),
    () => ({ ...bridgeEnvelope(NONCE, { type: "pong" }), type: "save", operations: [] }),
    () =>
      bridgeEnvelope("zzzzzzzzzzzzzzzzzzzzzz", { type: "selection", target: text("Other nonce") }),
  ])();
}

const deliver = (session: EditSession, data: unknown, origin = APP, source: unknown = frame) =>
  session.receive({ data, origin, source });

describe("edit mode against a hostile page", () => {
  it("saves exactly what the reader typed on the target they chose, whatever the page posts", () => {
    const rand = random(42);
    for (let run = 0; run < 2_000; run++) {
      const saved: Edit[] = [];
      const session = new EditSession(expected, (edit) => saved.push(edit));
      // Before edit mode, the page floods the viewer: nothing starts.
      for (let n = 0; n < 5; n++) deliver(session, forged(rand));
      expect(session.mode).toBe("idle");

      session.start("text");
      // The reader's real selection, then the page's forgeries while the editor is open.
      deliver(
        session,
        bridgeEnvelope(NONCE, { type: "selection", target: text("Hello world", 0) }),
      );
      expect(session.mode).toBe("editing");
      for (let n = 0; n < 10; n++) deliver(session, forged(rand));
      session.type("Hello there");
      for (let n = 0; n < 10; n++) deliver(session, forged(rand));
      expect(saved).toHaveLength(0);

      const shown = session.review() as Confirmation;
      expect(shown.lines).toEqual(["- Hello world", "+ Hello there"]);
      for (let n = 0; n < 10; n++) deliver(session, forged(rand));
      expect(session.confirm(shown)).toBe(true);
      expect(saved).toHaveLength(1);
      const op = saved[0]?.operations[0];
      expect(op).toMatchObject({ kind: "text", after: "Hello there" });
      expect(op?.target.anchor).toMatchObject({ kind: "text", quote: { exact: "Hello world" } });
    }
  });

  it("opens the editor on the first selection while choosing and freezes it", () => {
    const session = new EditSession(expected, () => {});
    session.start("text");
    deliver(session, bridgeEnvelope(NONCE, { type: "selection", target: text("Forged first", 0) }));
    deliver(session, bridgeEnvelope(NONCE, { type: "selection", target: text("Real", 0) }));
    session.type("Changed");
    const shown = session.review() as Confirmation;
    // A page that wins the race chooses the before, never the after, and the reader sees the
    // before in the viewer's editor and in the confirmation before saving anything.
    expect(shown.lines[0]).toBe("- Forged first");
  });

  it("drops messages from another origin, window or nonce, and messages no schema has", () => {
    const session = new EditSession(expected, () => {});
    session.start("text");
    deliver(
      session,
      bridgeEnvelope(NONCE, { type: "selection", target: text("x") }),
      "https://evil.example",
    );
    deliver(session, bridgeEnvelope(NONCE, { type: "selection", target: text("x") }), APP, {
      name: "other",
    });
    deliver(
      session,
      bridgeEnvelope("zzzzzzzzzzzzzzzzzzzzzz", { type: "selection", target: text("x") }),
    );
    deliver(session, { ...bridgeEnvelope(NONCE, { type: "pong" }), type: "edit", after: "x" });
    deliver(
      session,
      bridgeEnvelope(NONCE, { type: "element", target: element("not in text mode") }),
    );
    expect(session.mode).toBe("choosing");
    expect(session.dropped).toBe(5);
  });

  it("confirms only the confirmation it drew, once", () => {
    const saved: Edit[] = [];
    const session = new EditSession(expected, (edit) => saved.push(edit));
    expect(session.review()).toBeNull();
    session.start("text");
    deliver(session, bridgeEnvelope(NONCE, { type: "selection", target: text("Hello") }));
    session.type("Hello\nworld");
    expect(session.review()).toBeNull();
    // An invalid draft cannot be reviewed; the reader corrects it or starts again.
    session.start("text");
    deliver(session, bridgeEnvelope(NONCE, { type: "selection", target: text("Hello") }));
    session.type("Howdy");
    const shown = session.review() as Confirmation;
    const lookalike: Confirmation = { operations: shown.operations, lines: [...shown.lines] };
    expect(session.confirm(lookalike)).toBe(false);
    expect(session.confirm(shown)).toBe(true);
    expect(session.confirm(shown)).toBe(false);
    expect(saved).toHaveLength(1);
  });

  it("builds a style suggestion only from values the viewer's panel set and the allowlist accepts", () => {
    const saved: Edit[] = [];
    const session = new EditSession(expected, (edit) => saved.push(edit));
    session.start("style");
    deliver(session, bridgeEnvelope(NONCE, { type: "selection", target: text("not an element") }));
    expect(session.mode).toBe("choosing");
    deliver(session, bridgeEnvelope(NONCE, { type: "element", target: element("Hello") }));
    session.type("ignored in style mode");
    session.setStyle("position", "fixed");
    expect(session.review()).toBeNull();
    session.start("style");
    deliver(session, bridgeEnvelope(NONCE, { type: "element", target: element("Hello") }));
    session.setStyle("color", "red");
    session.setStyle("color", "navy");
    session.setStyle("font-weight", "700");
    const shown = session.review() as Confirmation;
    expect(shown.lines).toEqual(["color: navy", "font-weight: 700"]);
    session.cancel();
    expect(session.confirm(shown)).toBe(false);
    expect(saved).toHaveLength(0);
    session.setStyle("color", "red");
    session.type("x");
    expect(session.mode).toBe("idle");
  });
});
