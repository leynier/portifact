// Suggest mode's state, with no DOM (decision 0027, "Suggesting"; the spike's `EditSession`).
// The live frame is only a selection hint: while the person is choosing, a text selection that
// echoes the current edit epoch is offered for an edit, and while they pick an element for a
// style, the element that echoes it opens the style panel. Once an editor opens, the target is
// frozen and nothing the frame sends counts, its rectangles included: the editor stays where it
// was placed. What is typed or chosen stays here and is never sent to the frame. A new page, a
// route change, a status or a lost session ends the edit and its confirmation, whatever state it
// is in.
import type { EditKind, FrameRect } from "@portifact/bridge";
import {
  type AnnotationTarget,
  checkStyle,
  EDIT_LIMITS,
  Edit,
  type EditOperation,
  STYLE_PROPERTY_NAMES,
  type StyleProperty,
} from "@portifact/contracts";

/** A text selection's target: what a text edit points at. */
export type TextTarget = AnnotationTarget & {
  anchor: Extract<AnnotationTarget["anchor"], { kind: "text" }>;
};

/** A picked element's target: what a style operation points at. */
export type ElementTarget = AnnotationTarget & {
  anchor: Extract<AnnotationTarget["anchor"], { kind: "element" }>;
};

/** What an element is picked for. */
export type ElementPick = "style";

/** One property of a style suggestion as the panel holds it, before it is checked. */
export interface StyleRow {
  property: StyleProperty;
  after: string;
}

export interface SuggestOffer {
  /** The choosing period the offer was made in. */
  epoch: number;
  target: TextTarget;
  /** Where the bridge said it is drawn in the frame: a placement hint only. */
  rect: FrameRect | null;
  /** False once the bridge said it is no longer drawn. */
  drawn: boolean;
}

export type SuggestState =
  | { mode: "off"; epoch: number }
  | {
      mode: "choosing";
      epoch: number;
      offer: SuggestOffer | null;
      /** Picking an element in the frame (for a style), instead of selecting text. */
      pick: ElementPick | null;
    }
  | {
      mode: "styling";
      epoch: number;
      target: ElementTarget;
      /** Where the panel was placed when it opened; never moved by the frame. */
      rect: FrameRect | null;
      changes: StyleRow[];
      note: string;
      reviewing: boolean;
    }
  | {
      mode: "editing";
      epoch: number;
      target: TextTarget;
      /** Where the editor was placed when it opened; never moved by the frame. */
      rect: FrameRect | null;
      after: string;
      note: string;
      /** Showing the confirmation of exactly what Save sends. */
      reviewing: boolean;
    };

export type SuggestAction =
  | { type: "toggle"; on: boolean }
  | {
      type: "selection";
      target: AnnotationTarget | null;
      rect: FrameRect | null;
      epoch: number | null;
    }
  | { type: "selection-rect"; rect: FrameRect | null }
  /** Starts (or stops, `null`) picking an element in the frame: a new choosing period. */
  | { type: "pick"; kind: ElementPick | null }
  /** The bridge reported a picked element; it counts only while picking, for the epoch. */
  | {
      type: "element";
      target: AnnotationTarget;
      rect: FrameRect | null;
      epoch: number | null;
    }
  /** The bridge stopped picking (Escape, a refusal or an element sent). */
  | { type: "pick-ended" }
  | { type: "style"; index: number; change: Partial<StyleRow> }
  | { type: "style-add" }
  | { type: "style-remove"; index: number }
  /**
   * The person activated the control drawn for `offer`: the editor opens on that offer, the one
   * they saw, never on whatever the frame offered since (a page can replace it at the click).
   */
  | { type: "open"; offer: SuggestOffer }
  /** Opens the editor on a target found without the frame (the sidebar's text search). */
  | { type: "open-target"; target: TextTarget }
  | { type: "type"; after: string }
  | { type: "note"; note: string }
  | { type: "review" }
  | { type: "back" }
  | { type: "cancel" }
  | { type: "saved" }
  /** A new page, a route change, a status, or the frame stopped being a connected bridge. */
  | { type: "page-change" };

export const SUGGEST_OFF: SuggestState = { mode: "off", epoch: 0 };

const isText = (target: AnnotationTarget | null): target is TextTarget =>
  target?.anchor.kind === "text";
const isElement = (target: AnnotationTarget | null): target is ElementTarget =>
  target?.anchor.kind === "element";

/** A new choosing period: a fresh epoch, so earlier offers and replays no longer count. */
const choosing = (state: SuggestState, pick: ElementPick | null = null): SuggestState => ({
  mode: "choosing",
  epoch: state.epoch + 1,
  offer: null,
  pick,
});

/** The panel's first property, before the person chooses. */
const FIRST_ROW: StyleRow = { property: "color", after: "" };

export function suggestReducer(state: SuggestState, action: SuggestAction): SuggestState {
  switch (action.type) {
    case "toggle":
      if (action.on) return state.mode === "off" ? choosing(state) : state;
      return { mode: "off", epoch: state.epoch };
    case "pick":
      return state.mode === "choosing" ? choosing(state, action.kind) : state;
    case "element":
      if (state.mode !== "choosing" || state.pick === null) return state;
      if (action.epoch !== state.epoch || !isElement(action.target)) return state;
      return {
        mode: "styling",
        epoch: state.epoch,
        target: action.target,
        rect: action.rect,
        changes: [FIRST_ROW],
        note: "",
        reviewing: false,
      };
    case "pick-ended":
      return state.mode === "choosing" && state.pick !== null ? choosing(state) : state;
    case "style":
      if (state.mode !== "styling") return state;
      return {
        ...state,
        reviewing: false,
        changes: state.changes.map((row, index) =>
          index === action.index ? { ...row, ...action.change } : row,
        ),
      };
    case "style-add":
      if (state.mode !== "styling" || state.changes.length >= EDIT_LIMITS.styleChangesMax) {
        return state;
      }
      return { ...state, reviewing: false, changes: [...state.changes, nextRow(state.changes)] };
    case "style-remove":
      if (state.mode !== "styling" || state.changes.length <= 1) return state;
      return {
        ...state,
        reviewing: false,
        changes: state.changes.filter((_, index) => index !== action.index),
      };
    case "selection":
      if (state.mode !== "choosing") return state;
      // While an element is picked, a text selection offers nothing.
      if (state.pick !== null) return state;
      // Withdrawing an offer is always safe, whoever asks; offering needs the current epoch.
      if (action.target === null) return { ...state, offer: null };
      if (action.epoch !== state.epoch) return state;
      if (!isText(action.target)) return { ...state, offer: null };
      return {
        ...state,
        offer: { epoch: state.epoch, target: action.target, rect: action.rect, drawn: true },
      };
    case "selection-rect":
      if (state.mode !== "choosing" || !state.offer) return state;
      return {
        ...state,
        offer: {
          ...state.offer,
          rect: action.rect ?? state.offer.rect,
          drawn: action.rect !== null,
        },
      };
    case "open":
      if (state.mode !== "choosing" || action.offer.epoch !== state.epoch) return state;
      return editing(state, action.offer.target, action.offer.drawn ? action.offer.rect : null);
    case "open-target":
      if (state.mode === "off") return state;
      return editing(state, action.target, null);
    case "type":
      return state.mode === "editing" ? { ...state, after: action.after, reviewing: false } : state;
    case "note":
      return state.mode === "editing" || state.mode === "styling"
        ? { ...state, note: action.note }
        : state;
    case "review":
      return (state.mode === "editing" || state.mode === "styling") && editOf(state)
        ? { ...state, reviewing: true }
        : state;
    case "back":
      return state.mode === "editing" || state.mode === "styling"
        ? { ...state, reviewing: false }
        : state;
    case "cancel":
    case "saved":
    case "page-change":
      return state.mode === "off" ? state : choosing(state);
  }
}

function editing(state: SuggestState, target: TextTarget, rect: FrameRect | null): SuggestState {
  return {
    mode: "editing",
    epoch: state.epoch,
    target,
    rect,
    after: oneLine(target.anchor.quote.exact),
    note: "",
    reviewing: false,
  };
}

/** The editor is one line: line breaks of a selection crossing blocks become spaces. */
export const oneLine = (text: string): string => text.replace(/\r\n?|\n/g, " ");

/** A property not chosen yet, for a new row. */
function nextRow(rows: readonly StyleRow[]): StyleRow {
  const used = new Set(rows.map((row) => row.property));
  const free = STYLE_PROPERTY_NAMES.find((property) => !used.has(property)) ?? "color";
  return { property: free, after: "" };
}

/** Why a style row cannot be sent: its value is outside the grammar, or its property repeats. */
export function styleRowProblem(
  rows: readonly StyleRow[],
  index: number,
): "invalid" | "duplicate" | null {
  const row = rows[index];
  if (!row) return null;
  if (rows.findIndex((other) => other.property === row.property) !== index) return "duplicate";
  return checkStyle(row.property, row.after) === true ? null : "invalid";
}

/** The edit Save would send, or null while it is not one the contracts accept. */
export function editOf(state: SuggestState): Edit | null {
  let operation: EditOperation;
  if (state.mode === "editing") {
    operation = { kind: "text", target: state.target, after: state.after };
  } else if (state.mode === "styling") {
    if (state.changes.some((_, index) => styleRowProblem(state.changes, index) !== null)) {
      return null;
    }
    operation = {
      kind: "style",
      target: state.target,
      // The viewer never reads the page's computed style (decision 0027, rule 1): no before.
      changes: state.changes.map((row) => ({
        property: row.property,
        before: null,
        after: row.after,
      })),
    };
  } else {
    return null;
  }
  const parsed = Edit.safeParse({ operations: [operation] });
  return parsed.success ? parsed.data : null;
}

/** What the frame is told about edit mode: whether the person is choosing, and what for. */
export function editModeOf(state: SuggestState): { active: boolean; kind: EditKind } {
  if (state.mode !== "choosing") return { active: false, kind: "text" };
  return { active: true, kind: state.pick ?? "text" };
}
