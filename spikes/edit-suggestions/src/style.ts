// The style allowlist of decision 0027, narrowed for the first style delivery (rule 8). It is a
// syntax allowlist, not a proof of visual safety: a value the grammar accepts can still restyle,
// hide behind an existing layer or trigger the page's own selectors and observers. That is why a
// style change is never applied automatically, never runs in the live artifact (its preview is an
// inert copy) and is always reviewed by a person before it reaches the change list. What the
// grammars do guarantee: one property from a closed list and a value that matches a whole-string
// shape, so functions (`url()`, `var()`, `calc()`, `attr()`), escapes, comments, `!important`,
// smuggled declarations, relative or viewport units, zero sizes and transparent colors are
// impossible by construction.

const MAX_VALUE_LENGTH = 32;

/** Opaque named colors only: no `transparent`, `currentcolor` or `inherit`. */
const NAMED_COLORS = [
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
] as const;
/** Opaque hex colors: three or six digits, never an alpha digit. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;
const BYTE = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
/** `rgb(r, g, b)` or `rgb(r g b)`, one separator style, no alpha. */
const RGB = new RegExp(`^rgb\\((?:${BYTE}, ?${BYTE}, ?${BYTE}|${BYTE} ${BYTE} ${BYTE})\\)$`);

function isColor(value: string): boolean {
  return HEX.test(value) || RGB.test(value) || (NAMED_COLORS as readonly string[]).includes(value);
}

/** Whole pixels between `min` and `max`, written without leading zeros. */
const pixels = (min: number, max: number) => (value: string) => {
  const match = /^([1-9][0-9]{0,2}|0)px$/.exec(value);
  if (!match) return false;
  const amount = Number(match[1]);
  return amount >= min && amount <= max;
};

const keywords =
  (...allowed: string[]) =>
  (value: string) =>
    allowed.includes(value);

/**
 * Every property a style suggestion may change, with its grammar. Dropped for the first style
 * delivery (rule 8): `line-height` and the eight margin and padding properties (zero or large
 * values overlap or push content out of view). Never allowed: placement and layering
 * (`position`, `inset`, `top` and the others, `z-index`, `transform`, `float`, `width`,
 * `height`), hiding (`display`, `visibility`, `opacity`, `clip-path`, `filter`), generated text
 * (`content`, `quotes`, `counter-*`) and anything that can load a URL (`background`,
 * `background-image`, `list-style-image`, `cursor`, `font-family`, `mask`, `border-image`).
 */
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

/** Whether `property: value` is allowed. Values are compared exactly: lowercase, no spaces around. */
export function checkStyle(property: string, value: string): true | StyleRefusal {
  const grammar = Object.hasOwn(STYLE_PROPERTIES, property)
    ? STYLE_PROPERTIES[property]
    : undefined;
  if (!grammar) return "unknown_property";
  if (value.length === 0 || value.length > MAX_VALUE_LENGTH) return "too_long";
  return grammar(value) ? true : "not_allowed";
}
