import type { AnnotationTarget } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  editOf,
  oneLine,
  SUGGEST_OFF,
  type SuggestAction,
  type SuggestState,
  suggestReducer,
  type TextTarget,
} from "./suggest-session.ts";

const TARGET: TextTarget = {
  schema: 1,
  path: "index.md",
  anchor: {
    kind: "text",
    quote: { exact: "brave new world", prefix: "Hello ", suffix: "" },
    position: { start: 6, end: 21 },
  },
};
const ELEMENT: AnnotationTarget = {
  schema: 1,
  path: "index.md",
  anchor: { kind: "element", selectors: ["#a"], tagName: "p", fingerprint: "x" },
};
const RECT = { x: 1, y: 2, width: 3, height: 4 };

const run = (...actions: SuggestAction[]): SuggestState =>
  actions.reduce(suggestReducer, SUGGEST_OFF);
const on: SuggestAction = { type: "toggle", on: true };
const offer = (epoch: number | null, target: AnnotationTarget | null = TARGET): SuggestAction => ({
  type: "selection",
  target,
  rect: RECT,
  epoch,
});

describe("Suggest mode's session", () => {
  it("offers only a text selection that echoes the current epoch", () => {
    const choosing = run(on);
    expect(choosing).toEqual({ mode: "choosing", epoch: 1, offer: null });
    expect(suggestReducer(choosing, offer(null))).toBe(choosing);
    expect(suggestReducer(choosing, offer(2))).toBe(choosing);
    expect(suggestReducer(choosing, offer(1, ELEMENT))).toEqual({ ...choosing, offer: null });
    expect(suggestReducer(choosing, offer(1))).toMatchObject({
      offer: { target: TARGET, rect: RECT, drawn: true },
    });
    // Off, the frame offers nothing.
    expect(run(offer(0))).toEqual(SUGGEST_OFF);
  });

  it("freezes the target and the placement once the editor opens", () => {
    const editing = run(on, offer(1), { type: "open" });
    expect(editing).toMatchObject({
      mode: "editing",
      target: TARGET,
      rect: RECT,
      after: "brave new world",
    });
    // Nothing the frame sends counts from then on, rectangles and new selections included.
    expect(suggestReducer(editing, { type: "selection-rect", rect: null })).toBe(editing);
    expect(suggestReducer(editing, offer(1, { ...TARGET, path: "other.md" }))).toBe(editing);
  });

  it("follows the offered selection's rectangle while choosing, and hides it when gone", () => {
    const offered = run(on, offer(1));
    const moved = suggestReducer(offered, { type: "selection-rect", rect: { ...RECT, x: 9 } });
    expect(moved).toMatchObject({ offer: { rect: { x: 9 }, drawn: true } });
    const gone = suggestReducer(moved, { type: "selection-rect", rect: null });
    expect(gone).toMatchObject({ offer: { rect: { x: 9 }, drawn: false } });
    // A hidden selection opens an editor that is placed by the viewer, not by a stale rectangle.
    expect(suggestReducer(gone, { type: "open" })).toMatchObject({ rect: null });
    expect(suggestReducer(run(on), { type: "open" })).toEqual(run(on));
  });

  it("reviews only an edit the contracts accept, and typing again leaves the review", () => {
    const editing = run(on, offer(1), { type: "open" });
    expect(suggestReducer(editing, { type: "review" })).toBe(editing);
    expect(editOf(editing)).toBeNull();
    const typed = run(on, offer(1), { type: "open" }, { type: "type", after: "brave  world" });
    expect(editOf(typed)).toBeNull();
    const fixed = suggestReducer(typed, { type: "type", after: "bold new world" });
    expect(editOf(fixed)).toEqual({
      operations: [{ kind: "text", target: TARGET, after: "bold new world" }],
    });
    const reviewing = suggestReducer(fixed, { type: "review" });
    expect(reviewing).toMatchObject({ reviewing: true });
    expect(suggestReducer(reviewing, { type: "back" })).toMatchObject({ reviewing: false });
    expect(suggestReducer(reviewing, { type: "type", after: "x" })).toMatchObject({
      reviewing: false,
    });
    expect(suggestReducer(reviewing, { type: "note", note: "Why" })).toMatchObject({
      note: "Why",
      reviewing: true,
    });
    expect(editOf(SUGGEST_OFF)).toBeNull();
  });

  it("ends an edit and its confirmation on a page change, cancel or save, with a new epoch", () => {
    const reviewing = run(
      on,
      offer(1),
      { type: "open" },
      { type: "type", after: "x" },
      {
        type: "review",
      },
    );
    for (const type of ["page-change", "cancel", "saved"] as const) {
      expect(suggestReducer(reviewing, { type })).toEqual({
        mode: "choosing",
        epoch: 2,
        offer: null,
      });
    }
    // An offer of the old epoch no longer counts.
    const next = suggestReducer(reviewing, { type: "page-change" });
    expect(suggestReducer(next, offer(1))).toBe(next);
    expect(suggestReducer(SUGGEST_OFF, { type: "page-change" })).toBe(SUGGEST_OFF);
  });

  it("turns off from any state and keeps counting epochs", () => {
    const editing = run(on, offer(1), { type: "open" });
    const off = suggestReducer(editing, { type: "toggle", on: false });
    expect(off).toEqual({ mode: "off", epoch: 1 });
    expect(suggestReducer(off, on)).toMatchObject({ mode: "choosing", epoch: 2 });
    const choosing = run(on);
    expect(suggestReducer(choosing, on)).toBe(choosing);
    // Edits do nothing outside the editor.
    for (const action of [
      { type: "type", after: "x" },
      { type: "note", note: "x" },
      { type: "review" },
      { type: "back" },
      { type: "selection-rect", rect: RECT },
    ] as const) {
      expect(suggestReducer(choosing, action)).toBe(choosing);
    }
  });

  it("opens the editor on a target found without the frame, never while off", () => {
    expect(run({ type: "open-target", target: TARGET })).toEqual(SUGGEST_OFF);
    expect(run(on, { type: "open-target", target: TARGET })).toMatchObject({
      mode: "editing",
      rect: null,
    });
  });

  it("makes a selection across blocks one line", () => {
    expect(oneLine("a\nb\r\nc\rd")).toBe("a b c d");
  });
});
