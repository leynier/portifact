// The edit of a suggestion (decision 0027): a list of inert operations, each with its target in
// the existing anchor model. Text is text, a style change is a property and a value from the
// allowlist, a structure change names anchors and an action. Nothing here can carry markup, CSS
// or a URL, and every size is capped.
import { AnnotationTarget, codePointLength } from "@portifact/contracts";
import { z } from "zod";
import { checkStyle } from "./style.ts";

export const EDIT_LIMITS = {
  operationsMax: 20,
  styleChangesMax: 8,
  textMaxCodePoints: 1_024,
  /** The whole serialized edit, targets included. */
  editMaxBytes: 32 * 1024,
} as const;

const NORMALIZED = /^(?:[^\s\p{Cc}]| (?! ))*$/u;

/** Text as anchors store it: normalized, single line, at most 1,024 code points, may be empty. */
const EditText = z
  .string()
  .refine(
    (value) => value.isWellFormed() && value === value.normalize("NFC") && NORMALIZED.test(value),
    {
      message: "Text must be normalized: no control characters or repeated whitespace",
    },
  )
  .refine((value) => codePointLength(value) <= EDIT_LIMITS.textMaxCodePoints, {
    message: `Text is longer than ${EDIT_LIMITS.textMaxCodePoints} characters`,
  });

const textTarget = AnnotationTarget.refine((target) => target.anchor.kind === "text", {
  message: "A text operation targets a text selection",
});
const elementTarget = AnnotationTarget.refine((target) => target.anchor.kind === "element", {
  message: "This operation targets an element",
});

/** Replaces the selected text (the anchor's quote) with `after`. Empty `after` deletes it. */
export const TextOperation = z
  .strictObject({ kind: z.literal("text"), target: textTarget, after: EditText })
  .refine((op) => op.target.anchor.kind !== "text" || op.target.anchor.quote.exact !== op.after, {
    message: "The text did not change",
  });

const StyleChange = z
  .strictObject({
    property: z.string().max(32),
    /** The computed value the bridge saw: a hint for the owner, null when it fits no grammar. */
    before: z.string().max(32).nullable(),
    /** The new value, always inside the property's grammar. */
    after: z.string().max(32),
  })
  .superRefine((change, ctx) => {
    const verdict = checkStyle(change.property, change.after);
    if (verdict !== true) ctx.addIssue({ code: "custom", message: `Style refused: ${verdict}` });
    if (change.before !== null && checkStyle(change.property, change.before) !== true) {
      ctx.addIssue({ code: "custom", message: "Before value outside the grammar" });
    }
  });

export const StyleOperation = z.strictObject({
  kind: z.literal("style"),
  target: elementTarget,
  changes: z.array(StyleChange).min(1).max(EDIT_LIMITS.styleChangesMax),
});

/** Move before or after another element, duplicate in place, or remove. Never new markup. */
export const StructureOperation = z.discriminatedUnion("action", [
  z.strictObject({
    kind: z.literal("structure"),
    action: z.literal("move"),
    target: elementTarget,
    destination: z.strictObject({ target: elementTarget, place: z.enum(["before", "after"]) }),
  }),
  z.strictObject({
    kind: z.literal("structure"),
    action: z.literal("duplicate"),
    target: elementTarget,
  }),
  z.strictObject({
    kind: z.literal("structure"),
    action: z.literal("remove"),
    target: elementTarget,
  }),
]);

export const EditOperation = z.union([TextOperation, StyleOperation, StructureOperation]);
export type EditOperation = z.infer<typeof EditOperation>;

export const Edit = z
  .strictObject({ operations: z.array(EditOperation).min(1).max(EDIT_LIMITS.operationsMax) })
  .refine(
    (edit) => new TextEncoder().encode(JSON.stringify(edit)).length <= EDIT_LIMITS.editMaxBytes,
    {
      message: "Edit is too large",
    },
  )
  .refine((edit) => new Set(edit.operations.map((op) => op.target.path)).size === 1, {
    message: "Every operation of an edit is on the same page",
  });
export type Edit = z.infer<typeof Edit>;
