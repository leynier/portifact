// The viewer's side of edit mode (decision 0027), as a state machine with no DOM. The frame may
// only say where the reader's selection or picked element is, exactly as for comments today; the
// new text and style values are typed in the viewer's own editor, drawn over the frame, and the
// suggestion is saved only by the viewer's confirmation of the exact operations it shows. No
// bridge message carries an "after", and none can move the session forward past choosing.

import { type Expectation, type IncomingEvent, readBridgeMessage } from "@portifact/bridge";
import type { AnnotationTarget } from "@portifact/contracts";
import { Edit } from "./operations.ts";

export type EditKind = "text" | "style";

export interface Confirmation {
  readonly operations: Edit["operations"];
  /** What the viewer shows: the before and after as text, drawn by the viewer. */
  readonly lines: readonly string[];
}

type State =
  | { mode: "idle" }
  | { mode: "choosing"; kind: EditKind }
  | { mode: "editing"; kind: "text"; target: AnnotationTarget; before: string; draft: string }
  | {
      mode: "editing";
      kind: "style";
      target: AnnotationTarget;
      changes: { property: string; before: null; after: string }[];
    }
  | { mode: "confirming"; confirmation: Confirmation };

export class EditSession {
  private state: State = { mode: "idle" };
  /** Bridge messages the session dropped, for the tests. */
  dropped = 0;

  constructor(
    private readonly expected: Expectation,
    private readonly save: (edit: Edit) => void,
  ) {}

  get mode(): State["mode"] {
    return this.state.mode;
  }

  /** The reader chose "Suggest an edit" (text) or "Suggest a style" (an element) in the viewer. */
  start(kind: EditKind): void {
    this.state = { mode: "choosing", kind };
  }

  /** A message from the frame. Only a selection or a pick while choosing does anything. */
  receive(event: IncomingEvent): void {
    const message = readBridgeMessage(event, this.expected);
    const state = this.state;
    if (!message || state.mode !== "choosing") {
      this.dropped++;
      return;
    }
    if (
      state.kind === "text" &&
      message.type === "selection" &&
      message.target?.anchor.kind === "text"
    ) {
      const before = message.target.anchor.quote.exact;
      // The editor opens with the selected text; the target is frozen from here on.
      this.state = { mode: "editing", kind: "text", target: message.target, before, draft: before };
      return;
    }
    if (
      state.kind === "style" &&
      message.type === "element" &&
      message.target.anchor.kind === "element"
    ) {
      this.state = { mode: "editing", kind: "style", target: message.target, changes: [] };
      return;
    }
    this.dropped++;
  }

  /** The reader typed in the viewer's editor. */
  type(text: string): void {
    if (this.state.mode === "editing" && this.state.kind === "text") this.state.draft = text;
  }

  /** The reader set a style in the viewer's style panel. */
  setStyle(property: string, after: string): void {
    if (this.state.mode !== "editing" || this.state.kind !== "style") return;
    const changes = this.state.changes.filter((change) => change.property !== property);
    this.state.changes = [...changes, { property, before: null, after }];
  }

  /** The reader asked to review the suggestion: the viewer shows exactly these lines. */
  review(): Confirmation | null {
    const state = this.state;
    if (state.mode !== "editing") return null;
    const operations =
      state.kind === "text"
        ? [{ kind: "text" as const, target: state.target, after: state.draft }]
        : [{ kind: "style" as const, target: state.target, changes: state.changes }];
    const parsed = Edit.safeParse({ operations });
    if (!parsed.success) return null;
    const lines =
      state.kind === "text"
        ? [`- ${state.before}`, `+ ${state.draft}`]
        : state.changes.map((change) => `${change.property}: ${change.after}`);
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

  cancel(): void {
    this.state = { mode: "idle" };
  }
}
