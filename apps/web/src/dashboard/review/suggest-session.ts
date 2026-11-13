// Suggest mode's state, with no DOM (decision 0027, "Suggesting"; the spike's `EditSession`).
// The live frame is only a selection hint: while the person is choosing, a text selection that
// echoes the current edit epoch is offered for an edit. Once the editor opens, the target is frozen
// and nothing the frame sends counts, its rectangles included: the editor stays where it was
// placed. The after is typed here and never sent to the frame. A new page, a route change, a
// status or a lost session ends the edit and its confirmation, whatever state it is in.
import type { FrameRect } from "@portifact/bridge";
import { type AnnotationTarget, Edit } from "@portifact/contracts";

/** A text selection's target: what a text edit points at. */
export type TextTarget = AnnotationTarget & {
  anchor: Extract<AnnotationTarget["anchor"], { kind: "text" }>;
};

export interface SuggestOffer {
  target: TextTarget;
  /** Where the bridge said it is drawn in the frame: a placement hint only. */
  rect: FrameRect | null;
  /** False once the bridge said it is no longer drawn. */
  drawn: boolean;
}

export type SuggestState =
  | { mode: "off"; epoch: number }
  | { mode: "choosing"; epoch: number; offer: SuggestOffer | null }
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
  | { type: "open" }
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

/** A new choosing period: a fresh epoch, so earlier offers and replays no longer count. */
const choosing = (state: SuggestState): SuggestState => ({
  mode: "choosing",
  epoch: state.epoch + 1,
  offer: null,
});

export function suggestReducer(state: SuggestState, action: SuggestAction): SuggestState {
  switch (action.type) {
    case "toggle":
      if (action.on) return state.mode === "off" ? choosing(state) : state;
      return { mode: "off", epoch: state.epoch };
    case "selection":
      if (state.mode !== "choosing") return state;
      if (action.epoch !== state.epoch) return state;
      if (!isText(action.target)) return { ...state, offer: null };
      return { ...state, offer: { target: action.target, rect: action.rect, drawn: true } };
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
      if (state.mode !== "choosing" || !state.offer) return state;
      return editing(state, state.offer.target, state.offer.drawn ? state.offer.rect : null);
    case "open-target":
      if (state.mode === "off") return state;
      return editing(state, action.target, null);
    case "type":
      return state.mode === "editing" ? { ...state, after: action.after, reviewing: false } : state;
    case "note":
      return state.mode === "editing" ? { ...state, note: action.note } : state;
    case "review":
      return state.mode === "editing" && editOf(state) ? { ...state, reviewing: true } : state;
    case "back":
      return state.mode === "editing" ? { ...state, reviewing: false } : state;
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

/** The edit Save would send, or null while it is not one the contracts accept. */
export function editOf(state: SuggestState): Edit | null {
  if (state.mode !== "editing") return null;
  const parsed = Edit.safeParse({
    operations: [{ kind: "text", target: state.target, after: state.after }],
  });
  return parsed.success ? parsed.data : null;
}
