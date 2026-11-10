// Annotation targets (plan section 8, "Anclas"): where a thread points inside an immutable
// version. They arrive from the review bridge, the dashboard, the CLI and MCP, so every field is
// untrusted input: sizes are capped, unknown keys are refused and the structural fields (CSS
// selectors, tag names, paths and routes) follow grammars that cannot carry markup, CSS or URLs
// that navigate elsewhere. `packages/anchors` creates and resolves these targets.
import { z } from "zod";
import { LIMITS } from "./limits.ts";

/**
 * Limits for annotation targets. Text lengths and positions count Unicode code points of the
 * normalized text (see `packages/anchors`), never UTF-16 units.
 */
export const ANCHOR_LIMITS = {
  /** Plan section 2: a quote holds up to 1,024 characters plus bounded context. */
  quoteMaxCodePoints: 1_024,
  contextMaxCodePoints: 32,
  fingerprintMaxCodePoints: 128,
  /** Primary selector plus fallbacks. */
  selectorsMax: 4,
  selectorMaxLength: 512,
  selectorMaxCompounds: 32,
  attributeValueMaxLength: 128,
  tagNameMaxLength: 32,
  routeMaxLength: 2_048,
  rendererMaxLength: 64,
  sourceBlockMax: 1_000_000,
  /** A position can never exceed the bytes of the largest file any plan allows. */
  positionMax: LIMITS.fileBytesCap,
  rectMaxCoordinate: 10_000_000,
  /** Serialized JSON size of a whole target, in UTF-8 bytes. */
  targetMaxBytes: 8 * 1024,
} as const;

/** The current target schema version, stored with every thread. */
export const ANCHOR_SCHEMA_VERSION = 1;

/** Attributes that the element selector may use besides IDs, because sites set them on purpose. */
export const STABLE_SELECTOR_ATTRIBUTES = [
  "data-testid",
  "data-test-id",
  "data-test",
  "data-cy",
  "data-qa",
  "name",
] as const;

export function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

/** Normalized text has no whitespace or control characters other than single U+0020 spaces. */
const NORMALIZED_TEXT = /^(?:[^\s\p{Cc}]| (?! ))*$/u;

function normalizedText(maxCodePoints: number, label: string) {
  return z.string().superRefine((value, ctx) => {
    if (value.length > maxCodePoints * 2 || codePointLength(value) > maxCodePoints) {
      ctx.addIssue({
        code: "custom",
        message: `${label} is longer than ${maxCodePoints} characters`,
      });
      return;
    }
    if (!value.isWellFormed() || !NORMALIZED_TEXT.test(value)) {
      ctx.addIssue({
        code: "custom",
        message: `${label} must be normalized text: no control characters or repeated whitespace`,
      });
    }
  });
}

const IDENT = "-?[A-Za-z_][A-Za-z0-9_-]*";
const ATTRIBUTE_NAME = STABLE_SELECTOR_ATTRIBUTES.join("|");
const ATTRIBUTE_VALUE = `[^"\\\\<>\\u0000-\\u001f\\u007f]{0,${ANCHOR_LIMITS.attributeValueMaxLength}}`;
const PART = `(?:#${IDENT}|\\.${IDENT}|\\[(?:${ATTRIBUTE_NAME})="${ATTRIBUTE_VALUE}"\\]|:nth-of-type\\([1-9][0-9]{0,4}\\))`;
const COMPOUND = `(?:[a-z][a-z0-9-]*${PART}*|${PART}+)`;
const SELECTOR_GRAMMAR = new RegExp(`^${COMPOUND}(?:(?: > | )${COMPOUND})*$`);

/**
 * Whether a string is a CSS selector in the restricted grammar anchors use: type, `#id`,
 * `.class`, a stable attribute with a quoted value and `:nth-of-type(n)`, joined by descendant or
 * child combinators. No escapes, functions, at-rules, braces or semicolons are possible, so a
 * selector can never become CSS that loads a URL or markup that runs a script.
 */
export function isSafeSelector(value: string): boolean {
  if (value.length === 0 || value.length > ANCHOR_LIMITS.selectorMaxLength) return false;
  if (!SELECTOR_GRAMMAR.test(value)) return false;
  const compounds = value.replace(/"[^"]*"/g, '""').split(/ > | /).length;
  return compounds <= ANCHOR_LIMITS.selectorMaxCompounds;
}

export const CssSelector = z.string().refine(isSafeSelector, {
  message: "Selector is not in the allowed CSS selector grammar",
});

/** W3C Web Annotation TextQuoteSelector: the quote and bounded context on each side. */
export const TextQuote = z.strictObject({
  exact: normalizedText(ANCHOR_LIMITS.quoteMaxCodePoints, "Quote").refine(
    (value) => value.length > 0 && !value.startsWith(" ") && !value.endsWith(" "),
    { message: "Quote must be non-empty and must not start or end with a space" },
  ),
  prefix: normalizedText(ANCHOR_LIMITS.contextMaxCodePoints, "Prefix"),
  suffix: normalizedText(ANCHOR_LIMITS.contextMaxCodePoints, "Suffix"),
});
export type TextQuote = z.infer<typeof TextQuote>;

const position = z.int().min(0).max(ANCHOR_LIMITS.positionMax);

/** W3C Web Annotation TextPositionSelector over the normalized text, in code points. */
export const TextPosition = z
  .strictObject({ start: position, end: position })
  .refine((value) => value.end > value.start, { message: "Position end must follow its start" });
export type TextPosition = z.infer<typeof TextPosition>;

/** Where the quote sits in the original source: the Markdown block and source offsets, or TXT offsets. */
export const SourcePosition = z
  .strictObject({
    block: z.int().min(0).max(ANCHOR_LIMITS.sourceBlockMax).optional(),
    start: position,
    end: position,
  })
  .refine((value) => value.end > value.start, { message: "Source end must follow its start" });
export type SourcePosition = z.infer<typeof SourcePosition>;

export const TextAnchor = z
  .strictObject({
    kind: z.literal("text"),
    quote: TextQuote,
    position: TextPosition,
    /** Selector of the element around the selection in HTML, a hint to break ties. */
    domHint: CssSelector.optional(),
    source: SourcePosition.optional(),
  })
  .refine(
    (value) => value.position.end - value.position.start === codePointLength(value.quote.exact),
    { message: "Position length must equal the quote length" },
  );
export type TextAnchor = z.infer<typeof TextAnchor>;

const coordinate = z
  .number()
  .min(-ANCHOR_LIMITS.rectMaxCoordinate)
  .max(ANCHOR_LIMITS.rectMaxCoordinate);
const extent = z.number().min(0).max(ANCHOR_LIMITS.rectMaxCoordinate);

/** The element's box when it was selected, in CSS pixels of the page. Only a visual hint. */
export const AnchorRect = z.strictObject({
  x: coordinate,
  y: coordinate,
  width: extent,
  height: extent,
});
export type AnchorRect = z.infer<typeof AnchorRect>;

export const ElementAnchor = z.strictObject({
  kind: z.literal("element"),
  /** Primary selector first, then fallbacks. */
  selectors: z.array(CssSelector).min(1).max(ANCHOR_LIMITS.selectorsMax),
  tagName: z
    .string()
    .max(ANCHOR_LIMITS.tagNameMaxLength)
    .regex(/^[a-z][a-z0-9-]*$/, "Invalid tag name"),
  /** The element's normalized text, truncated: confirms the selector still finds the same element. */
  fingerprint: normalizedText(ANCHOR_LIMITS.fingerprintMaxCodePoints, "Fingerprint"),
  rect: AnchorRect.optional(),
});
export type ElementAnchor = z.infer<typeof ElementAnchor>;

/** A general comment on the whole document or path. */
export const DocumentAnchor = z.strictObject({ kind: z.literal("document") });
export type DocumentAnchor = z.infer<typeof DocumentAnchor>;

export const Anchor = z.discriminatedUnion("kind", [DocumentAnchor, TextAnchor, ElementAnchor]);
export type Anchor = z.infer<typeof Anchor>;

/** A file path inside a version: relative, forward slashes, no empty, `.` or `..` segments. */
export const AnchorPath = z
  .string()
  .min(1)
  .max(LIMITS.pathMaxLength)
  .refine(
    (value) =>
      value.isWellFormed() &&
      !/[\p{Cc}\\]/u.test(value) &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    { message: "Invalid path" },
  );

/**
 * The SPA route inside a page (`location.pathname` plus `location.hash`). It must be a path on
 * the same origin: it starts with one slash and holds no whitespace or control characters.
 */
export const AnchorRoute = z
  .string()
  .max(ANCHOR_LIMITS.routeMaxLength)
  .refine((value) => value.isWellFormed() && /^\/(?!\/)[^\s\p{Cc}\\]*$/u.test(value), {
    message: "Route must be a same-origin path",
  });

/** A thread's target: the file, optional SPA route, the renderer that produced the text and the anchor. */
export const AnnotationTarget = z
  .strictObject({
    schema: z.literal(ANCHOR_SCHEMA_VERSION),
    path: AnchorPath,
    route: AnchorRoute.optional(),
    /** Lowercase hex SHA-256 of the normalized text the anchor was created against. */
    contentHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "Invalid content hash")
      .optional(),
    /** Renderer name and version for Markdown and TXT, for example `render@1.2.0`. */
    renderer: z
      .string()
      .max(ANCHOR_LIMITS.rendererMaxLength)
      .regex(/^[a-z0-9][a-z0-9.@/+_-]*$/, "Invalid renderer")
      .optional(),
    anchor: Anchor,
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= ANCHOR_LIMITS.targetMaxBytes,
    { message: `Target is larger than ${ANCHOR_LIMITS.targetMaxBytes} bytes` },
  );
export type AnnotationTarget = z.infer<typeof AnnotationTarget>;
