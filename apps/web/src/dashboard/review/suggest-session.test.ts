import type { AnnotationTarget } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  editModeOf,
  editOf,
  oneLine,
  SUGGEST_OFF,
  type SuggestAction,
  type SuggestState,
  styleRowProblem,
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
    expect(choosing).toEqual({ mode: "choosing", epoch: 1, offer: null, pick: null });
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
        pick: null,
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

describe("Suggest mode's style panel", () => {
  const element = {
    schema: 1 as const,
    path: "index.html",
    anchor: { kind: "element" as const, selectors: ["#x"], tagName: "p", fingerprint: "Hi" },
  };
  const choosingState = () => suggestReducer(SUGGEST_OFF, { type: "toggle", on: true });
  const picking = () => suggestReducer(choosingState(), { type: "pick", kind: "style" });
  const styling = () => {
    const state = picking();
    return suggestReducer(state, {
      type: "element",
      target: element,
      rect: null,
      epoch: state.epoch,
    });
  };

  it("picks in a new epoch and opens the panel only on an element of that epoch", () => {
    const before = choosingState();
    const state = picking();
    expect(state).toMatchObject({ mode: "choosing", pick: "style", epoch: before.epoch + 1 });
    expect(editModeOf(state)).toEqual({ active: true, kind: "style" });
    expect(
      suggestReducer(state, { type: "element", target: element, rect: null, epoch: before.epoch }),
    ).toBe(state);
    expect(
      suggestReducer(state, { type: "element", target: TARGET, rect: null, epoch: state.epoch }),
    ).toBe(state);
    // Not picking: an element of the epoch opens nothing.
    expect(
      suggestReducer(before, { type: "element", target: element, rect: null, epoch: before.epoch }),
    ).toBe(before);
    expect(styling()).toMatchObject({
      mode: "styling",
      changes: [{ property: "color", after: "" }],
    });
    expect(editModeOf(styling())).toEqual({ active: false, kind: "text" });
  });

  it("goes back to selecting text when the pick ends, and offers no text while picking", () => {
    const state = picking();
    expect(
      suggestReducer(state, { type: "selection", target: TARGET, rect: null, epoch: state.epoch }),
    ).toBe(state);
    const ended = suggestReducer(state, { type: "pick-ended" });
    expect(ended).toMatchObject({ mode: "choosing", pick: null, epoch: state.epoch + 1 });
    // A pick-ended outside a pick changes nothing.
    expect(suggestReducer(ended, { type: "pick-ended" })).toBe(ended);
    expect(suggestReducer(styling(), { type: "pick-ended" }).mode).toBe("styling");
  });

  it("holds one to eight rows, each a property not chosen yet, and builds the edit only when all are valid", () => {
    let state = styling();
    expect(editOf(state)).toBeNull();
    state = suggestReducer(state, { type: "style", index: 0, change: { after: "red" } });
    expect(editOf(state)?.operations[0]).toEqual({
      kind: "style",
      target: element,
      changes: [{ property: "color", before: null, after: "red" }],
    });
    expect(suggestReducer(state, { type: "style-remove", index: 0 })).toBe(state);
    for (let i = 0; i < 10; i++) state = suggestReducer(state, { type: "style-add" });
    if (state.mode !== "styling") throw new Error("not styling");
    expect(state.changes.map((row) => row.property)).toEqual([
      "color",
      "background-color",
      "font-size",
      "font-weight",
      "font-style",
      "text-align",
      "text-decoration-line",
      "text-transform",
    ]);
    expect(editOf(state)).toBeNull();
    state = suggestReducer(state, {
      type: "style",
      index: 1,
      change: { property: "color", after: "blue" },
    });
    if (state.mode !== "styling") throw new Error("not styling");
    expect(styleRowProblem(state.changes, 0)).toBeNull();
    expect(styleRowProblem(state.changes, 1)).toBe("duplicate");
    expect(styleRowProblem(state.changes, 2)).toBe("invalid");
    expect(styleRowProblem(state.changes, 9)).toBeNull();
    state = suggestReducer(state, { type: "style-remove", index: 1 });
    if (state.mode !== "styling") throw new Error("not styling");
    expect(state.changes).toHaveLength(7);
  });

  it("reviews only a valid style, keeps the note and ends with the page", () => {
    let state = styling();
    expect(suggestReducer(state, { type: "review" })).toBe(state);
    state = suggestReducer(state, { type: "style", index: 0, change: { after: "#fff" } });
    state = suggestReducer(state, { type: "note", note: "Lighter" });
    state = suggestReducer(state, { type: "review" });
    expect(state).toMatchObject({ mode: "styling", reviewing: true, note: "Lighter" });
    expect(suggestReducer(state, { type: "back" })).toMatchObject({ reviewing: false });
    // Changing a row leaves the review.
    expect(
      suggestReducer(state, { type: "style", index: 0, change: { after: "#000" } }),
    ).toMatchObject({ reviewing: false });
    const ended = suggestReducer(state, { type: "page-change" });
    expect(ended).toMatchObject({ mode: "choosing", pick: null, epoch: state.epoch + 1 });
    // Style actions do nothing outside the panel.
    for (const action of [
      { type: "style", index: 0, change: { after: "red" } },
      { type: "style-add" },
      { type: "style-remove", index: 0 },
      { type: "pick", kind: "style" },
    ] as const) {
      expect(suggestReducer(SUGGEST_OFF, action)).toBe(SUGGEST_OFF);
    }
  });
});

describe("Suggest mode's structure panel", () => {
  const element = {
    schema: 1 as const,
    path: "index.html",
    anchor: { kind: "element" as const, selectors: ["#x"], tagName: "p", fingerprint: "Hi" },
  };
  const other = { ...element, anchor: { ...element.anchor, selectors: ["#y"], fingerprint: "Yo" } };
  const structuring = () => {
    const on = suggestReducer(SUGGEST_OFF, { type: "toggle", on: true });
    const picking = suggestReducer(on, { type: "pick", kind: "structure" });
    return suggestReducer(picking, {
      type: "element",
      target: element,
      rect: null,
      epoch: picking.epoch,
    });
  };

  it("opens on a structure pick, moving by default, with no edit until a destination", () => {
    const state = structuring();
    expect(state).toMatchObject({ mode: "structuring", action: "move", destination: null });
    expect(editOf(state)).toBeNull();
    expect(suggestReducer(state, { type: "review" })).toBe(state);
  });

  it("takes a destination only while picking it, in its epoch, and never the element itself", () => {
    const state = structuring();
    if (state.mode !== "structuring") throw new Error("not structuring");
    // Not picking: an element of the epoch is no destination.
    expect(
      suggestReducer(state, { type: "element", target: other, rect: null, epoch: state.epoch }),
    ).toBe(state);
    const choosing = suggestReducer(state, { type: "destination-pick", on: true });
    expect(choosing).toMatchObject({ choosing: true, epoch: state.epoch + 1, opened: state.epoch });
    expect(editModeOf(choosing)).toEqual({ active: true, kind: "structure" });
    for (const [target, epoch] of [
      [element, choosing.epoch],
      [other, state.epoch],
    ] as const) {
      expect(suggestReducer(choosing, { type: "element", target, rect: null, epoch })).toBe(
        choosing,
      );
    }
    const chosen = suggestReducer(choosing, {
      type: "element",
      target: other,
      rect: null,
      epoch: choosing.epoch,
    });
    expect(chosen).toMatchObject({ choosing: false, destination: other });
    const before = suggestReducer(chosen, { type: "place", place: "before" });
    expect(editOf(before)?.operations[0]).toEqual({
      kind: "structure",
      action: "move",
      target: element,
      destination: { target: other, place: "before" },
    });
    // Escape in the frame ends the pick in a new epoch, the panel stays.
    const ended = suggestReducer(choosing, { type: "pick-ended" });
    expect(ended).toMatchObject({
      mode: "structuring",
      choosing: false,
      epoch: choosing.epoch + 1,
    });
  });

  it("duplicates and removes with no destination, and only a move picks one", () => {
    const remove = suggestReducer(structuring(), { type: "structure-action", action: "remove" });
    expect(editOf(remove)?.operations[0]).toEqual({
      kind: "structure",
      action: "remove",
      target: element,
    });
    expect(suggestReducer(remove, { type: "destination-pick", on: true })).toBe(remove);
    const duplicate = suggestReducer(remove, { type: "structure-action", action: "duplicate" });
    expect(editOf(duplicate)?.operations[0]).toMatchObject({ action: "duplicate" });
    const reviewing = suggestReducer(suggestReducer(duplicate, { type: "note", note: "Twice" }), {
      type: "review",
    });
    expect(reviewing).toMatchObject({ reviewing: true, note: "Twice" });
    expect(suggestReducer(reviewing, { type: "back" })).toMatchObject({ reviewing: false });
    expect(suggestReducer(reviewing, { type: "page-change" }).mode).toBe("choosing");
    for (const action of [
      { type: "structure-action", action: "remove" },
      { type: "destination-pick", on: true },
      { type: "place", place: "before" },
    ] as const) {
      expect(suggestReducer(SUGGEST_OFF, action)).toBe(SUGGEST_OFF);
    }
  });
});
