// The viewer's side of edit mode (decision 0027), as a state machine with no DOM. The live frame
// is only a selection hint (rule 3): it may say where the reader's selection or picked element is
// while the viewer is choosing, exactly as for comments today. From then on the frame is ignored,
// its geometry included (rule 2): the editor stays where the viewer placed it and moves only with
// the viewer's own viewport events. The new text and style values are typed in the viewer's
// editor and never posted to the frame (rule 1); the only messages the viewer sends it are the
// mode and the pick, which carry no text. A move's destination is chosen in a separate, explicit
// pick state. The suggestion is saved only by the viewer's confirmation of the exact lines it drew,
// shown with the same typed display as the owner's (invisible characters as tokens), and a new
// page, a route change or the end of the session invalidates the edit and its confirmation.

import {
  type Expectation,
  type FrameRect,
  type IncomingEvent,
  readBridgeMessage,
  type ViewerBody,
} from "@portifact/bridge";
import type { AnnotationTarget } from "@portifact/contracts";
import { visible } from "./display.ts";
import { Edit } from "./operations.ts";

export type EditKind = "text" | "style" | "move";

export interface Confirmation {
  readonly operations: Edit["operations"];
  /** What the viewer shows: the before and after as text, drawn by the viewer. */
  readonly lines: readonly string[];
}

type Editing =
  | { kind: "text"; target: AnnotationTarget; before: string; draft: string }
  | {
      kind: "style";
      target: AnnotationTarget;
      changes: { property: string; before: null; after: string }[];
    }
  | {
      kind: "move";
      target: AnnotationTarget;
      destination: { target: AnnotationTarget; place: "before" | "after" } | null;
    };

type State =
  | { mode: "idle" }
  | { mode: "choosing"; kind: EditKind }
  | ({ mode: "editing" } & Editing)
  | {
      mode: "picking-destination";
      editing: Extract<Editing, { kind: "move" }>;
      place: "before" | "after";
    }
  | { mode: "confirming"; confirmation: Confirmation };

const PICK_HINT = "Choose an element";

export class EditSession {
  private state: State = { mode: "idle" };
  /** Bridge messages the session dropped, for the tests. */
  dropped = 0;
  /** Where the viewer draws the editor, in the frame's box; set once, when the editor opens. */
  placement: FrameRect | null = null;
  /** Every message the viewer sent to the frame. None may carry text the person typed. */
  readonly framePosts: ViewerBody[] = [];

  constructor(
    private readonly expected: Expectation,
    private readonly save: (edit: Edit) => void,
  ) {}

  get mode(): State["mode"] {
    return this.state.mode;
  }

  private post(body: ViewerBody): void {
    this.framePosts.push(body);
  }

  /** The reader chose "Suggest an edit" (text), "Suggest a style" or "Move" in the viewer. */
  start(kind: EditKind): void {
    this.state = { mode: "choosing", kind };
    this.placement = null;
    if (kind !== "text") this.post({ type: "pick", active: true, hint: PICK_HINT });
  }

  /** A message from the frame. Only a selection or a pick in the matching state does anything. */
  receive(event: IncomingEvent): void {
    const message = readBridgeMessage(event, this.expected);
    const state = this.state;
    if (!message) {
      this.dropped++;
      return;
    }
    // Lifecycle (rule 9 of the second round): a new page, a route change or the review session's
    // end invalidates the edit and its confirmation, whatever state it was in.
    if (message.type === "location" || message.type === "ready" || message.type === "status") {
      if (state.mode !== "idle") this.invalidate();
      return;
    }
    if (state.mode === "choosing") {
      if (
        state.kind === "text" &&
        message.type === "selection" &&
        message.target?.anchor.kind === "text"
      ) {
        const before = message.target.anchor.quote.exact;
        this.state = {
          mode: "editing",
          kind: "text",
          target: message.target,
          before,
          draft: before,
        };
        this.placement = message.rect ?? null;
        return;
      }
      if (
        state.kind !== "text" &&
        message.type === "element" &&
        message.target.anchor.kind === "element"
      ) {
        this.state =
          state.kind === "style"
            ? { mode: "editing", kind: "style", target: message.target, changes: [] }
            : { mode: "editing", kind: "move", target: message.target, destination: null };
        this.placement = message.rect ?? null;
        this.post({ type: "pick", active: false, hint: PICK_HINT });
        return;
      }
    }
    if (
      state.mode === "picking-destination" &&
      message.type === "element" &&
      message.target.anchor.kind === "element"
    ) {
      this.state = {
        mode: "editing",
        ...state.editing,
        destination: { target: message.target, place: state.place },
      };
      this.post({ type: "pick", active: false, hint: PICK_HINT });
      return;
    }
    // Editing, confirming and everything else: the frame has no say, rectangles included.
    this.dropped++;
  }

  /** The viewer's own viewport changed (scroll or resize of the viewer page, never the frame's). */
  viewportChanged(placement: FrameRect): void {
    if (this.state.mode !== "idle") this.placement = placement;
  }

  /** The reader typed in the viewer's editor. Nothing is sent to the frame. */
  type(text: string): void {
    if (this.state.mode === "editing" && this.state.kind === "text") this.state.draft = text;
  }

  /** The reader set a style in the viewer's style panel. */
  setStyle(property: string, after: string): void {
    if (this.state.mode !== "editing" || this.state.kind !== "style") return;
    const changes = this.state.changes.filter((change) => change.property !== property);
    this.state.changes = [...changes, { property, before: null, after }];
  }

  /** The reader chose "Pick the destination" for a move: one explicit pick, then back to editing. */
  pickDestination(place: "before" | "after"): void {
    if (this.state.mode !== "editing" || this.state.kind !== "move") return;
    const { mode: _mode, ...editing } = this.state;
    this.state = { mode: "picking-destination", editing, place };
    this.post({ type: "pick", active: true, hint: PICK_HINT });
  }

  /** The reader asked to review the suggestion: the viewer shows exactly these lines. */
  review(): Confirmation | null {
    const state = this.state;
    if (state.mode !== "editing") return null;
    let operations: unknown[];
    let lines: string[];
    if (state.kind === "text") {
      operations = [{ kind: "text", target: state.target, after: state.draft }];
      lines = [`- ${visible(state.before)}`, `+ ${visible(state.draft)}`];
    } else if (state.kind === "style") {
      operations = [{ kind: "style", target: state.target, changes: state.changes }];
      lines = state.changes.map((change) => `${change.property}: ${visible(change.after)}`);
    } else {
      if (!state.destination) return null;
      operations = [
        { kind: "structure", action: "move", target: state.target, destination: state.destination },
      ];
      lines = [`move ${state.destination.place} the chosen element`];
    }
    const parsed = Edit.safeParse({ operations });
    if (!parsed.success) return null;
    const confirmation: Confirmation = Object.freeze({
      operations: parsed.data.operations,
      lines: Object.freeze(lines),
    });
    this.state = { mode: "confirming", confirmation };
    return confirmation;
  }

  /** The reader pressed Save on the confirmation the viewer drew. */
  confirm(shown: Confirmation): boolean {
    if (this.state.mode !== "confirming" || this.state.confirmation !== shown) return false;
    this.save({ operations: shown.operations });
    this.state = { mode: "idle" };
    return true;
  }

  /** Edits and confirmations invalidated by navigation or the session's end, for the tests. */
  invalidated = 0;

  /** The dashboard session or the review session ended. */
  sessionEnded(): void {
    if (this.state.mode !== "idle") this.invalidate();
  }

  private invalidate(): void {
    this.state = { mode: "idle" };
    this.placement = null;
    this.invalidated++;
  }

  cancel(): void {
    this.state = { mode: "idle" };
  }
}
