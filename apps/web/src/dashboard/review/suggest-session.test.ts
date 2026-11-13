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
/** Opens the editor on the offer currently drawn, as the control does. */
const openOffered = (state: SuggestState): SuggestState =>
  state.mode === "choosing" && state.offer
    ? suggestReducer(state, { type: "open", offer: state.offer })
    : state;
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
      offer: { epoch: 1, target: TARGET, rect: RECT, drawn: true },
    });
    // Off, the frame offers nothing.
    expect(run(offer(0))).toEqual(SUGGEST_OFF);
  });

  it("freezes the target and the placement once the editor opens", () => {
    const editing = openOffered(run(on, offer(1)));
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
    expect(openOffered(gone)).toMatchObject({ rect: null });
    expect(openOffered(run(on))).toEqual(run(on));
  });

  it("reviews only an edit the contracts accept, and typing again leaves the review", () => {
    const editing = openOffered(run(on, offer(1)));
    expect(suggestReducer(editing, { type: "review" })).toBe(editing);
    expect(editOf(editing)).toBeNull();
    const typed = suggestReducer(openOffered(run(on, offer(1))), {
      type: "type",
      after: "brave  world",
    });
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
    const reviewing = [{ type: "type", after: "x" } as const, { type: "review" } as const].reduce(
      suggestReducer,
      openOffered(run(on, offer(1))),
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
    const editing = openOffered(run(on, offer(1)));
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

  it("opens on the offer the person activated, never on one the frame sent at the click", () => {
    const offered = run(on, offer(1));
    if (offered.mode !== "choosing" || !offered.offer) throw new Error("no offer");
    const activated = offered.offer;
    const replaced = suggestReducer(offered, offer(1, { ...TARGET, path: "other.md" }));
    expect(suggestReducer(replaced, { type: "open", offer: activated })).toMatchObject({
      mode: "editing",
      target: TARGET,
    });
    // An offer from an earlier choosing period opens nothing.
    const later = suggestReducer(suggestReducer(offered, { type: "cancel" }), offer(2));
    expect(suggestReducer(later, { type: "open", offer: activated })).toBe(later);
  });

  it("withdraws the offer when its selection is gone, whatever the epoch", () => {
    const offered = run(on, offer(1));
    expect(suggestReducer(offered, offer(null, null))).toMatchObject({ offer: null });
    expect(suggestReducer(offered, offer(1, null))).toMatchObject({ offer: null });
  });

  it("makes a selection across blocks one line", () => {
    expect(oneLine("a\nb\r\nc\rd")).toBe("a b c d");
  });
});
