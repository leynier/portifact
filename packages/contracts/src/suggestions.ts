// Edit suggestions (decision 0027): the edit model, the patch plan and its canonical envelopes, the
// change list and the refusal reasons. An edit arrives from a person in the viewer, so every field
// is untrusted: unknown keys are refused, sizes are capped and text is normalized plain text that
// cannot carry markup, CSS or a URL. What the server produces (plans, envelopes, change items) is
// read by released CLIs and MCP clients, so those shapes are tolerant: unknown keys are stripped,
// and reasons and states are lowercase tokens a client older than a new value still accepts. A
// change to what a format-1 envelope or plan means bumps its `format`.
import { z } from "zod";
import { AnnotationTarget, codePointLength } from "./anchors.ts";
import {
  AnnotationBody,
  AnnotationId,
  AnnotationPage,
  AnnotationThreadView,
} from "./annotations.ts";
import { TurnstileToken } from "./human.ts";

/** The switch that turns suggestions on, on the app and jobs Workers only (never deployed yet). */
export const SUGGESTIONS_SWITCH = "SUGGESTIONS_ENABLED";

/** Limits of one submitted edit (decision 0027, "The edit model"). */
export const EDIT_LIMITS = {
  operationsMax: 20,
  styleChangesMax: 8,
  /** Text of an `after`, in code points (as anchor quotes count them). */
  textMaxCodePoints: 1_024,
  /** The whole serialized edit, targets included, in UTF-8 bytes. */
  editMaxBytes: 32 * 1024,
} as const;

/** Limits of the owner's draft (decision 0027, "The owner's draft"). */
export const DRAFT_LIMITS = {
  operationsMax: 100,
  editMaxBytes: 128 * 1024,
  /** Drafts one person keeps at once, across artifacts. */
  perUser: 20,
  /** A draft nobody saved for this long is deleted. */
  unusedDays: 30,
  /** Saves one person makes in a window (decision 0027, "Costs and limits"). */
  savesPerUser: 120,
  savesWindowMs: 10 * 60_000,
} as const;

/** Bounds of a patch plan, enforced inside the planners (decision 0027, "Budget"). */
export const PLAN_LIMITS = {
  /** Operations one plan takes; the rest are listed as `too_large`. */
  operationsMax: 100,
  /** Largest Markdown or text file a plan reads, in UTF-8 bytes of the stored file (2 MB). */
  documentBytes: 2_000_000,
  /** Largest HTML file a plan parses, in UTF-8 bytes, and its largest node count. */
  htmlBytes: 1_048_576,
  htmlNodes: 50_000,
  /** One envelope and a whole plan, serialized, in UTF-8 bytes; checked before hashing. */
  envelopeBytes: 16 * 1024,
  planBytes: 512 * 1024,
  /** Stored file shown on each side of a change, in UTF-16 units. */
  contextUnits: 120,
  /** Node-local context persisted with a proof, in UTF-16 units. */
  proofContextUnits: 32,
  /** One persisted proof, serialized, in UTF-8 bytes (the change item's column allows this). */
  proofBytes: 16 * 1024,
  /** Attribute values longer than this are recorded in a proof's identity by their SHA-256. */
  identityValueUnits: 64,
  /**
   * A link destination is kept whole; only when an envelope would be over its limit are its
   * destinations shortened to this many units, with the omission marked and the attribute's
   * place in the stored file kept so the whole value can be read there.
   */
  destinationUnits: 1_024,
  /** How long a built plan is cached by its digest. */
  cacheMinutes: 10,
} as const;

/** Limits of the change list (decision 0027, "The change list"). */
export const CHANGE_LIST_LIMITS = {
  openPerArtifact: 1_000,
  /** Closed items are pruned this long after closing. */
  closedRetentionDays: 90,
  /** Node-local context the two sides of a closure proof need together, in UTF-16 units. */
  closureMinContextUnits: 8,
  /** Items one page of the list returns by default and at most. */
  pageDefault: 50,
  pageMax: 100,
} as const;

/** Suggestions carried in one run of the carry job; the rest continue in the next. */
export const CARRY_BATCH_MAX = 200;

/** Normalized text: no whitespace or control characters other than single inner spaces. */
const NORMALIZED = /^(?:[^\s\p{Cc}]| (?! ))*$/u;

/** Text as anchors store it: NFC, single line, at most 1,024 code points, may be empty. */
export const EditText = z.string().superRefine((value, ctx) => {
  if (
    value.length > EDIT_LIMITS.textMaxCodePoints * 2 ||
    codePointLength(value) > EDIT_LIMITS.textMaxCodePoints
  ) {
    ctx.addIssue({
      code: "custom",
      message: `Text is longer than ${EDIT_LIMITS.textMaxCodePoints} characters`,
    });
    return;
  }
  if (!value.isWellFormed() || value !== value.normalize("NFC") || !NORMALIZED.test(value)) {
    ctx.addIssue({
      code: "custom",
      message: "Text must be normalized: no control characters or repeated whitespace",
    });
  }
});

// The style grammar (decision 0027, "The edit model"): a syntax allowlist, never a proof of
// visual safety. Values are compared exactly, lowercase, with no spaces around them, so functions,
// escapes, comments, `!important`, smuggled declarations, relative and viewport units, zero sizes
// and transparent colors cannot be written.
const STYLE_VALUE_MAX = 32;
const NAMED_COLORS: readonly string[] = [
  "black",
  "white",
  "gray",
  "silver",
  "red",
  "maroon",
  "orange",
  "yellow",
  "olive",
  "lime",
  "green",
  "teal",
  "aqua",
  "blue",
  "navy",
  "purple",
  "fuchsia",
];
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;
const BYTE = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const RGB = new RegExp(`^rgb\\((?:${BYTE}, ?${BYTE}, ?${BYTE}|${BYTE} ${BYTE} ${BYTE})\\)$`);
const isColor = (value: string) =>
  HEX.test(value) || RGB.test(value) || NAMED_COLORS.includes(value);
const pixels = (min: number, max: number) => (value: string) => {
  const match = /^([1-9][0-9]{0,2}|0)px$/.exec(value);
  return match !== null && Number(match[1]) >= min && Number(match[1]) <= max;
};
const keywords =
  (...allowed: string[]) =>
  (value: string) =>
    allowed.includes(value);

/** Every property a style operation may change, with its grammar. */
export const STYLE_PROPERTIES: Readonly<Record<string, (value: string) => boolean>> = {
  color: isColor,
  "background-color": isColor,
  "font-size": pixels(8, 96),
  "font-weight": keywords(
    "normal",
    "bold",
    "100",
    "200",
    "300",
    "400",
    "500",
    "600",
    "700",
    "800",
    "900",
  ),
  "font-style": keywords("normal", "italic"),
  "text-align": keywords("left", "right", "center", "justify", "start", "end"),
  "text-decoration-line": keywords("none", "underline", "line-through", "overline"),
  "text-transform": keywords("none", "uppercase", "lowercase", "capitalize"),
  "letter-spacing": (value) => value === "normal" || pixels(0, 10)(value),
  "border-radius": pixels(0, 64),
};

export type StyleRefusal = "unknown_property" | "too_long" | "not_allowed";

/** Whether `property: value` is allowed. */
export function checkStyle(property: string, value: string): true | StyleRefusal {
  const grammar = Object.hasOwn(STYLE_PROPERTIES, property)
    ? STYLE_PROPERTIES[property]
    : undefined;
  if (!grammar) return "unknown_property";
  if (value.length === 0 || value.length > STYLE_VALUE_MAX) return "too_long";
  return grammar(value) ? true : "not_allowed";
}

const textTarget = AnnotationTarget.refine((target) => target.anchor.kind === "text", {
  message: "A text operation targets a text selection",
});
const elementTarget = AnnotationTarget.refine((target) => target.anchor.kind === "element", {
  message: "This operation targets an element",
});

/** Replaces the selected text (the anchor's quote) with `after`; an empty `after` deletes it. */
export const TextOperation = z
  .strictObject({ kind: z.literal("text"), target: textTarget, after: EditText })
  .refine((op) => op.target.anchor.kind !== "text" || op.target.anchor.quote.exact !== op.after, {
    message: "The text did not change",
  });
export type TextOperation = z.infer<typeof TextOperation>;

export const StyleChange = z
  .strictObject({
    property: z.string().max(STYLE_VALUE_MAX),
    /** The value the viewer saw: a hint for the owner, null when it fits no grammar. */
    before: z.string().max(STYLE_VALUE_MAX).nullable(),
    after: z.string().max(STYLE_VALUE_MAX),
  })
  .superRefine((change, ctx) => {
    const verdict = checkStyle(change.property, change.after);
    if (verdict !== true) ctx.addIssue({ code: "custom", message: `Style refused: ${verdict}` });
    if (change.before !== null && checkStyle(change.property, change.before) !== true) {
      ctx.addIssue({ code: "custom", message: "Before value outside the grammar" });
    }
  });
export type StyleChange = z.infer<typeof StyleChange>;

export const StyleOperation = z.strictObject({
  kind: z.literal("style"),
  target: elementTarget,
  changes: z.array(StyleChange).min(1).max(EDIT_LIMITS.styleChangesMax),
});
export type StyleOperation = z.infer<typeof StyleOperation>;

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
export type StructureOperation = z.infer<typeof StructureOperation>;

export const EditOperation = z.union([TextOperation, StyleOperation, StructureOperation]);
export type EditOperation = z.infer<typeof EditOperation>;

/** Every target an operation names: its own, and a move's destination. */
export function operationTargets(op: EditOperation): AnnotationTarget[] {
  return op.kind === "structure" && op.action === "move"
    ? [op.target, op.destination.target]
    : [op.target];
}

/** One page: the same file and the same route (no route counts as one value). */
const pageKey = (target: AnnotationTarget) => JSON.stringify([target.path, target.route ?? null]);

/** Whether two text operations select touching text, in base coordinates (adjacent included). */
export function textOperationsOverlap(operations: readonly EditOperation[]): boolean {
  const spans = operations.flatMap((op) =>
    op.kind === "text" && op.target.anchor.kind === "text" ? [op.target.anchor.position] : [],
  );
  return spans.some((a, i) =>
    spans.some((b, j) => i !== j && a.start <= b.end && b.start <= a.end),
  );
}

const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

function editSchema(operationsMax: number, bytesMax: number) {
  return z
    .strictObject({ operations: z.array(EditOperation).min(1).max(operationsMax) })
    .superRefine((edit, ctx) => {
      if (utf8Bytes(edit) > bytesMax) {
        ctx.addIssue({ code: "custom", message: "Edit is too large" });
        return;
      }
      if (new Set(edit.operations.flatMap(operationTargets).map(pageKey)).size !== 1) {
        ctx.addIssue({
          code: "custom",
          message: "Every operation and destination of an edit is on the same page and route",
        });
      }
      if (textOperationsOverlap(edit.operations)) {
        ctx.addIssue({
          code: "custom",
          message: "Two text operations of an edit touch the same text: change it once",
        });
      }
    });
}

/** A suggestion's edit: at most 20 operations on one page, at most 32 KiB. */
export const Edit = editSchema(EDIT_LIMITS.operationsMax, EDIT_LIMITS.editMaxBytes);
export type Edit = z.infer<typeof Edit>;

/** The owner's draft: the same rules with 100 operations and 128 KiB (one page per draft). */
export const DraftEdit = editSchema(DRAFT_LIMITS.operationsMax, DRAFT_LIMITS.editMaxBytes);
export type DraftEdit = z.infer<typeof DraftEdit>;

export const THREAD_KINDS = ["comment", "suggestion"] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

export const SUGGESTION_STATES = [
  "pending",
  "applying",
  "accepted",
  "rejected",
  "withdrawn",
  "outdated",
] as const;
export const SuggestionState = z.enum(SUGGESTION_STATES);
export type SuggestionState = z.infer<typeof SuggestionState>;

/**
 * Why an acceptance attempt ended without completing: the recovery table's reasons, a plan that
 * changed before the job ran, and access lost meanwhile (transfer, deletion, suspension, hold or
 * role). The suggestion goes back to `pending` with it.
 */
export const ATTEMPT_END_REASONS = [
  "failed",
  "version_conflict",
  "quota_exceeded",
  "capacity_unavailable",
  "plan_changed",
  "revoked",
] as const;
export type AttemptEndReason = (typeof ATTEMPT_END_REASONS)[number];

/** A lowercase token: tolerant for reasons and states that later releases may add. */
export const Token = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** Why an operation was listed instead of applied (decision 0027, "Locating and mapping"). */
export const REFUSAL_REASONS = [
  "stale",
  "invalid_after",
  "spans_blocks",
  "not_found",
  "would_change_page",
  "whitespace",
  "not_nfc",
  "spans_nodes",
  "not_eligible",
  "entity",
  "diagram",
  "renderer_changed",
  "too_large",
  "overlap",
  "not_text",
] as const;
export const RefusalReason = z.enum(REFUSAL_REASONS);
export type RefusalReason = z.infer<typeof RefusalReason>;

/**
 * What a client says for each refusal, in English (the CLI and MCP). The dashboard translates
 * them in its catalogs under `suggestion.refusal.<reason>`.
 */
export const REFUSAL_MESSAGES: Readonly<Record<RefusalReason, string>> = {
  stale: "The page changed since this text was selected. Select it again.",
  invalid_after: "The new text must be one line of plain text that differs from the old.",
  spans_blocks: "The change crosses two blocks, so it goes to the change list.",
  not_found:
    "This text cannot be matched to one place in the source, so it goes to the change list.",
  would_change_page:
    "Applying this would change something else on the page (a heading link, a reference or markup), so it goes to the change list.",
  whitespace:
    "The selection crosses line breaks or spacing the page keeps, so it goes to the change list.",
  not_nfc: "This text is stored in another Unicode form, so it goes to the change list.",
  spans_nodes: "The selection crosses formatting or a link, so it goes to the change list.",
  not_eligible:
    "This page uses features Portifact does not edit automatically (scripts, forms, embedded content and others), so it goes to the change list.",
  entity:
    "This text is written with a character reference Portifact cannot map, so it goes to the change list.",
  diagram: "Changes to a diagram's source go to the change list.",
  renderer_changed:
    "This document was rendered by an earlier version of Portifact, so changes go to the change list.",
  too_large:
    "This file or change is too large to apply automatically, so it goes to the change list.",
  overlap: "Two changes touch the same text. Combine them into one.",
  not_text:
    "Style and structure changes are never applied automatically: they go to the change list.",
};

export const FILE_KINDS = ["markdown", "text", "html"] as const;
export const FileKind = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof FileKind>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** What a plan is bound to: any change of it invalidates the plan. */
export const PlanBinding = z.object({
  artifactId: z.string().min(1).max(64),
  versionId: z.string().min(1).max(64),
  path: z.string().min(1).max(1_024),
  /** SHA-256 of the stored file the plan was built from. */
  fileSha256: Sha256,
  /** The renderer the plan verified as reproducing the stored rendering. */
  renderer: z.string().min(1).max(64),
  /** The SPA route of the page every operation targets, or null for none. */
  route: z.string().max(2_048).nullable(),
  /** The suggestion (thread ID) or the draft (`draft:<user>`) and its revision. */
  subject: z.string().min(1).max(128),
  revision: z.number().int().nonnegative(),
});
export type PlanBinding = z.infer<typeof PlanBinding>;

/**
 * Whether each person of an envelope is known: the canonical envelope holds no names (they are
 * account references kept beside it, which account erasure clears), only whether there is one.
 */
export const EnvelopePeople = z.object({ submitter: z.boolean(), acceptor: z.boolean() });
export type EnvelopePeople = z.infer<typeof EnvelopePeople>;

/** What a shown or exported envelope names: display names, or `DELETED_ACCOUNT`. */
export const Provenance = z.object({
  submittedBy: z.string().max(256),
  acceptedBy: z.string().max(256),
});
export type Provenance = z.infer<typeof Provenance>;

/** The name shown for a person whose account is gone. */
export const DELETED_ACCOUNT = "a deleted account";

/** A rendered block and the UTF-16 range of the source it came from (the stored block map). */
export interface RenderedBlock {
  id: string;
  start: number;
  end: number;
}

/** One file a commit stores for a document: its page, or a Markdown document's block map. */
export interface StoredFileText {
  kind: "rendered" | "block_map";
  text: string;
}

/**
 * What the planners need from the renderer (`DOCUMENT_RENDERER` in `@portifact/render`), passed in
 * so the domain never imports the renderer and its dependencies.
 */
export interface DocumentRenderer {
  /** The label plans bind: `portifact-render@<version>`. */
  readonly label: string;
  /** The files a commit stores for a document: the page first, then a Markdown block map. */
  stored(
    kind: "markdown" | "text",
    source: string,
    options: { title: string; sourceSha256: string },
  ): StoredFileText[];
  /** A document's body as the renderer draws it, for previews. */
  body(kind: "markdown" | "text", source: string): string;
}

/** The options a document's stored rendering was made with; flags are pinned by the renderer. */
export const StoredRenderOptions = z.object({ title: z.string().max(1_024) });
export type StoredRenderOptions = z.infer<typeof StoredRenderOptions>;

/** What the new version holds when anything applies. */
export const PlanOutput = z.object({
  sha256: Sha256,
  /** Bytes of the new file. */
  size: z.number().int().nonnegative(),
  renderedSha256: Sha256.nullable(),
  blockMapSha256: Sha256.nullable(),
  options: StoredRenderOptions.nullable(),
});
export type PlanOutput = z.infer<typeof PlanOutput>;

/** What a destination's `origin` says when its effective URL could not be parsed. */
export const UNPARSED_ORIGIN = "could not be parsed";

/**
 * A link around or inside a change: its spelling and where it really goes (resolved against the
 * page's URL and its HTML `base`). `origin` is the effective URL's scheme and host, always whole,
 * shown before the value and never shortened, or `UNPARSED_ORIGIN`; `resolved` is false then.
 * Only `authored` and `effective` may be shortened, with the omission counted, when an envelope
 * would be over its limit; `at` is where the authored value sits in a stored file (`source` for
 * an HTML page, `rendered` for a document's stored page), so it can be read whole there.
 */
export const Destination = z.object({
  origin: z.string(),
  authored: z.string(),
  effective: z.string(),
  resolved: z.boolean(),
  authoredOmitted: z.number().int().nonnegative(),
  effectiveOmitted: z.number().int().nonnegative(),
  at: z
    .object({
      file: z.enum(["source", "rendered"]),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type Destination = z.infer<typeof Destination>;

export const EnvelopeLocation = z.union([
  z.object({
    unit: z.literal("utf16"),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
  }),
  z.object({ unresolved: z.literal(true) }),
]);
export type EnvelopeLocation = z.infer<typeof EnvelopeLocation>;

export const EnvelopeContext = z.object({
  before: z.string(),
  after: z.string(),
  omittedBefore: z.number().int().nonnegative(),
  omittedAfter: z.number().int().nonnegative(),
});
export type EnvelopeContext = z.infer<typeof EnvelopeContext>;

/** A short description of an element the person picked: its tag and its visible label. */
export const ElementDescription = z.object({ tag: z.string().max(32), label: z.string().max(256) });

export const EnvelopeOperation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), before: z.string(), after: z.string() }),
  z.object({
    kind: z.literal("style"),
    element: ElementDescription,
    changes: z.array(
      z.object({ property: z.string(), before: z.string().nullable(), after: z.string() }),
    ),
  }),
  z.object({
    kind: z.literal("structure"),
    action: z.enum(["move", "duplicate", "remove"]),
    element: ElementDescription,
    destination: z
      .object({ element: ElementDescription, place: z.enum(["before", "after"]) })
      .nullable(),
  }),
]);
export type EnvelopeOperation = z.infer<typeof EnvelopeOperation>;

/**
 * The canonical envelope of one operation (decision 0027, "The envelope"): stored immutably with
 * a change item and covered by the plan's digest. Never the reviewer's note, anchor context,
 * selectors, fingerprints, proof data or a person's name. `location` is resolved only when proven
 * from the selected text through its source map; `context` is given only with it.
 * `destinationsKnown` is false when the selection could not be placed on the page, so its links
 * are not known.
 */
export const Envelope = z.object({
  format: z.literal(1),
  status: z.enum(["applied", "listed"]),
  reason: Token.nullable(),
  operation: EnvelopeOperation,
  binding: PlanBinding,
  people: EnvelopePeople,
  location: EnvelopeLocation,
  context: EnvelopeContext.nullable(),
  destinations: z.array(Destination),
  destinationsKnown: z.boolean(),
});
export type Envelope = z.infer<typeof Envelope>;

/** An envelope as it is shown and exported: the canonical one with its people's current names. */
export const ShownEnvelope = Envelope.extend({ provenance: Provenance });
export type ShownEnvelope = z.infer<typeof ShownEnvelope>;

/** The plan's contents: everything its digest covers. */
export const PlanContents = z.object({
  format: z.literal(1),
  binding: PlanBinding,
  kind: FileKind,
  applied: z.array(Envelope),
  listed: z.array(Envelope),
  output: PlanOutput.nullable(),
  lines: z.array(z.string()),
});
export type PlanContents = z.infer<typeof PlanContents>;

/** A plan as the viewer receives it: its contents and the digest the person confirms. */
export const Plan = PlanContents.extend({ digest: Sha256 });
export type Plan = z.infer<typeof Plan>;

/**
 * The proof data persisted with a change item or a carried operation (decision 0027, "Suggestions
 * and new versions"). Offsets are UTF-16 units of the stored file's string. Never exported.
 */
export const Proof = z.object({
  unit: z.literal("utf16"),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  before: z.string(),
  after: z.string(),
  shownBefore: z.string(),
  shownAfter: z.string(),
  nodeLeft: z.string().max(PLAN_LIMITS.proofContextUnits),
  nodeRight: z.string().max(PLAN_LIMITS.proofContextUnits),
  identity: z.array(z.string()),
});
export type Proof = z.infer<typeof Proof>;

export const CHANGE_ITEM_STATES = ["open", "applied", "dismissed", "closed_by_version"] as const;
export const ChangeItemState = z.enum(CHANGE_ITEM_STATES);
export type ChangeItemState = z.infer<typeof ChangeItemState>;

export const CHANGE_ITEM_ORIGINS = ["suggestion", "draft"] as const;
export type ChangeItemOrigin = (typeof CHANGE_ITEM_ORIGINS)[number];

/** Why a text item stays open after a version (decision 0027, "Closing by itself"). */
export const CLOSURE_OPEN_REASONS = [
  "short_context",
  "ambiguous",
  "not_shown",
  "target_changed",
] as const;
export type ClosureOpenReason = (typeof CLOSURE_OPEN_REASONS)[number];

/** Why a pending suggestion could not be carried to a new version. */
export const CARRY_OUTDATED_REASONS = [
  "changed",
  "not_on_page",
  "target_changed",
  "marker_in_source",
  "not_eligible",
  "not_planned",
] as const;
export type CarryOutdatedReason = (typeof CARRY_OUTDATED_REASONS)[number];

/** A future envelope format a released client does not know: kept as it comes. */
const LaterEnvelope = z.looseObject({ format: z.number().int().min(2) });

/** A change-list item as the API, MCP and the CLI return it. */
export const ChangeItemView = z.object({
  id: z.string(),
  artifactId: z.string(),
  origin: Token,
  threadId: z.string().nullable(),
  versionId: z.string(),
  path: z.string(),
  route: z.string().nullable(),
  envelope: z.union([ShownEnvelope, LaterEnvelope]),
  reason: Token.nullable(),
  state: Token,
  createdAt: z.number().int(),
  closedAt: z.number().int().nullable(),
  /** The version whose rendered page proved the change, when it closed by itself. */
  closedVersionId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
});
export type ChangeItemView = z.infer<typeof ChangeItemView>;

export const ChangeItemList = z.object({
  items: z.array(ChangeItemView),
  nextCursor: z.string().nullable(),
});
export type ChangeItemList = z.infer<typeof ChangeItemList>;

/** Marking an item: a person or the owner's agent says it is applied, dismissed or open again. */
export const MarkChangeItem = z.strictObject({
  state: z.enum(["applied", "dismissed", "open"]),
  baseRevision: z.number().int().nonnegative(),
});
export type MarkChangeItem = z.infer<typeof MarkChangeItem>;

/** Accepting or publishing a draft confirms a plan by its digest. */
export const ConfirmPlan = z.strictObject({ digest: Sha256 });
export type ConfirmPlan = z.infer<typeof ConfirmPlan>;

/**
 * Bounds of the suggestion services (decision 0027, "Costs and limits"): the acceptance rate limit,
 * the acceptance attempt's lifetime, how long records are kept and how much a run reads.
 */
export const SUGGESTION_LIMITS = {
  // Planning windows (dry runs, previews, acceptances) are `PLANNING_RATE_LIMITS` below.
  /** Acceptances and draft publishes started per owner per day (a version or not). */
  acceptsPerOwner: 100,
  acceptsOwnerWindowMs: 24 * 60 * 60_000,
  /** An attempt still running after this many deliveries or this long is ended as `failed`. */
  attemptDeliveries: 3,
  attemptMs: 30 * 60_000,
  /** Ended and done attempts, with their claims, are deleted this long after they started. */
  attemptRetentionMs: 30 * 24 * 60 * 60_000,
  /** Change items checked for closure, and suggestions carried, in one run of their job. */
  itemsPerCheck: 200,
  /**
   * A document's stored rendering or block map a plan reads at most, in bytes, checked by its
   * stored size before reading; a larger one is no baseline (everything is listed).
   */
  renderingReadBytes: 16 * 1024 * 1024,
  /**
   * Stored bytes one run of a carry or closure job reads at most: each unit (a carry group's two
   * pages, a closure's page; sources only) is admitted by its stored size before any read, the
   * rest continues in the next job. Two pages at their largest fit, so a unit always does.
   */
  jobReadBytes: 8 * 1024 * 1024,
} as const;

/**
 * The proof data persisted with a suggestion once it was planned (`annotation_threads.edit_proofs`,
 * decision 0027, "Suggestions and new versions"), one entry per operation of its edit, in the
 * edit's order: where the selected text is on `versionId`'s page (code points, as an anchor's
 * position) and its proof, or null for an operation that was never located (style and structure
 * operations among them). The submitted edit never changes; a carry rewrites only this. Never
 * exported or shown.
 */
export const SuggestionProofs = z.object({
  format: z.literal(1),
  versionId: z.string().min(1).max(64),
  operations: z.array(
    z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        proof: Proof,
      })
      .nullable(),
  ),
});
export type SuggestionProofs = z.infer<typeof SuggestionProofs>;

/** A suggestion as its own route returns it (`?fields=suggestion` adds the same block). */
export const SuggestionView = z.object({
  threadId: z.string(),
  artifactId: z.string(),
  versionId: z.string(),
  state: Token,
  /** The submitted edit; null once withdrawn. Untrusted reviewer text. */
  edit: z.unknown().nullable(),
  revision: z.number().int().nonnegative(),
  /** Why the last acceptance ended without completing, while the suggestion is pending again. */
  attemptReason: Token.nullable(),
  decidedAt: z.number().int().nullable(),
  resultVersionId: z.string().nullable(),
  /** Where a carried suggestion was made. */
  originVersionId: z.string().nullable(),
  /** Whether the suggestion was planned on its current version, so it can be carried. */
  planned: z.boolean(),
});
export type SuggestionView = z.infer<typeof SuggestionView>;

/** What starting an acceptance or a draft publish answers: the attempt the job runs. */
export const AcceptanceStarted = z.object({
  attemptId: z.string(),
  state: z.literal("applying"),
});
export type AcceptanceStarted = z.infer<typeof AcceptanceStarted>;

/**
 * Planning work a person may cause (decision 0027, "Costs and limits"): dry runs and previews
 * share these windows in `rate_limits`, per person and per artifact.
 */
export const PLANNING_RATE_LIMITS = {
  perUser: { requests: 30, windowMs: 10 * 60_000 },
  perArtifact: { requests: 10, windowMs: 60_000 },
} as const;

/** The `rate_limits` keys of planning work, shared by dry runs and previews. */
export const planningRateKeys = (userId: string, artifactId: string) => ({
  user: `suggestion-plan:user:${userId}`,
  artifact: `suggestion-plan:artifact:${artifactId}`,
});

/**
 * Built previews on the preview origin (decision 0027, "Previews"): the reserved host's label on
 * the content domain, the one path a code is redeemed at, how long a code lives, the age at which
 * the every-minute scan deletes a built document nobody redeemed (nothing can use it after the
 * code's minute), and how many codes one person holds open in each region (the regional
 * `preview_codes_limit` trigger).
 */
export const PREVIEW_CODES = {
  hostLabel: "preview",
  pathPrefix: "/p/",
  ttlMs: 60_000,
  documentTtlMs: 2 * 60_000,
  openPerUser: 10,
} as const;

/** A preview code as it travels: 32 random bytes in base64url, nothing else. */
export const PreviewCode = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** The reserved preview host on a content domain: never an artifact ID (`ArtifactId`). */
export const previewHost = (contentDomain: string) => `${PREVIEW_CODES.hostLabel}.${contentDomain}`;

/** What the viewer asks for: a preview of the plan it holds by digest. */
export const PreviewRequest = z.strictObject({ digest: Sha256 });
export type PreviewRequest = z.infer<typeof PreviewRequest>;

/**
 * A preview: a one-use URL on the preview host, or why there is none. `reasons` are refusal
 * reasons and preview reasons (`css_too_complex`), as tokens, so a later reason never breaks a
 * released client.
 */
export const PreviewResponse = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), url: z.string().url(), expiresAt: z.string() }),
  z.object({ state: z.literal("unavailable"), reasons: z.array(Token) }),
]);
export type PreviewResponse = z.infer<typeof PreviewResponse>;

// Route bodies (decision 0027, the adapters). Requests are strict; answers stay tolerant.

/**
 * Submitting a suggestion on the artifact's current version (session only): the edit, and the
 * reviewer's note as the thread's first message. The edit is validated by `Edit` in the service,
 * so a refusal names the rule it broke.
 */
export const SubmitSuggestionRequest = z.strictObject({
  versionId: AnnotationId,
  edit: z.unknown(),
  body: AnnotationBody,
  turnstileToken: TurnstileToken.optional(),
});
export type SubmitSuggestionRequest = z.infer<typeof SubmitSuggestionRequest>;

/** Rejecting or withdrawing a suggestion, at the suggestion revision the caller saw. */
export const DecideSuggestionRequest = z.strictObject({
  revision: z.number().int().nonnegative(),
});
export type DecideSuggestionRequest = z.infer<typeof DecideSuggestionRequest>;

/** `?fields=suggestion` on the annotation thread routes adds `kind` and `suggestion`. */
export const SuggestionFieldsQuery = z.object({ fields: z.literal("suggestion").optional() });

/** A thread view with its kind and, for a suggestion, the suggestion (`?fields=suggestion`). */
export const SuggestionThreadView = AnnotationThreadView.extend({
  kind: Token,
  suggestion: SuggestionView.nullable(),
});
export type SuggestionThreadView = z.infer<typeof SuggestionThreadView>;

/** The annotation list with `?fields=suggestion`. */
export const SuggestionAnnotationPage = AnnotationPage.extend({
  threads: z.array(SuggestionThreadView),
});
export type SuggestionAnnotationPage = z.infer<typeof SuggestionAnnotationPage>;

/**
 * Saving one's own draft (session only): the whole edit, on the artifact's current version, at
 * the draft revision the caller holds (null for a new draft). The viewer coalesces repeated
 * edits of the same text into one operation before sending.
 */
export const SaveDraftRequest = z.strictObject({
  baseVersionId: AnnotationId,
  edit: DraftEdit,
  baseRevision: z.number().int().min(1).nullable(),
});
export type SaveDraftRequest = z.infer<typeof SaveDraftRequest>;

/** One's own draft on an artifact. Its edit is the author's own text. */
export const DraftView = z.object({
  artifactId: z.string(),
  baseVersionId: z.string(),
  edit: z.unknown(),
  revision: z.number().int().min(1),
  /** Whether a publish of it is running (its job decides). */
  publishing: z.boolean(),
  /** Why the last publish ended without completing. */
  attemptReason: Token.nullable(),
  updatedAt: z.number().int(),
});
export type DraftView = z.infer<typeof DraftView>;

/** Listing the change list: one state or all, oldest first, paged by cursor. */
export const ChangeItemListQuery = z.object({
  state: ChangeItemState.optional(),
  cursor: z.string().max(128).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CHANGE_LIST_LIMITS.pageMax)
    .default(CHANGE_LIST_LIMITS.pageDefault),
});
export type ChangeItemListQuery = z.infer<typeof ChangeItemListQuery>;
