// The style allowlist of decision 0027. A style change is one property from a closed list and a
// value that matches that property's grammar, written as a whole string match. Nothing is
// parsed as CSS: a value that is not exactly one of the shapes below is refused, so functions
// (`url()`, `image-set()`, `var()`, `attr()`, `expression()`), escapes, comments, `!important`,
// declarations smuggled after a semicolon, and properties that place, layer, hide or fetch are
// impossible by construction, not filtered out.

const MAX_VALUE_LENGTH = 32;

/** Colors: hex, `rgb()` with plain numbers, a short list of keywords. Never a function name else. */
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
  "transparent",
  "currentcolor",
  "inherit",
] as const;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const BYTE = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const ALPHA = "(?:0|1|0?\\.[0-9]{1,3})";
const RGB = new RegExp(
  `^rgba?\\(${BYTE}(?:, ?| )${BYTE}(?:, ?| )${BYTE}(?:(?:, ?| / )${ALPHA})?\\)$`,
);

function isColor(value: string): boolean {
  return HEX.test(value) || RGB.test(value) || (NAMED_COLORS as readonly string[]).includes(value);
}

interface LengthRule {
  /** Largest value per unit; units not listed are refused. */
  max: Partial<Record<"px" | "em" | "rem" | "%", number>>;
  /** Whether a unitless number is allowed (line-height), and its largest value. */
  unitless?: number;
}

const LENGTH = /^(0|[0-9]{1,4}(?:\.[0-9]{1,3})?)(px|em|rem|%)?$/;

function isLength(value: string, rule: LengthRule): boolean {
  const match = LENGTH.exec(value);
  if (!match) return false;
  const amount = Number(match[1]);
  const unit = match[2] as keyof LengthRule["max"] | undefined;
  if (unit === undefined)
    return amount === 0 || (rule.unitless !== undefined && amount <= rule.unitless);
  const max = rule.max[unit];
  return max !== undefined && amount <= max;
}

const keywords =
  (...allowed: string[]) =>
  (value: string) =>
    allowed.includes(value);

const SPACING: LengthRule = { max: { px: 400, em: 20, rem: 20, "%": 50 } };

/**
 * Every property a suggestion may change, with its grammar. Left out on purpose: `position`,
 * `inset`, `top`/`left`/..., `z-index`, `transform`, `translate`, `float`, `width`, `height`
 * (overlays and covering other content); `display`, `visibility`, `opacity`, `clip-path`,
 * `filter` (hiding content: removing is a structure change the owner sees as such); `content`,
 * `quotes`, `counter-*` (text that is not in the page); `background`, `background-image`,
 * `list-style-image`, `cursor`, `font-family`, `src`, `mask` and `border-image` (each can load a
 * URL, so a viewer's preview would make a request); negative margins (overlap).
 */
export const STYLE_PROPERTIES: Readonly<Record<string, (value: string) => boolean>> = {
  color: isColor,
  "background-color": isColor,
  "font-size": (value) =>
    isLength(value, { max: { px: 96, em: 6, rem: 6, "%": 600 } }) && value !== "0",
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
  "line-height": (value) =>
    value === "normal" ||
    isLength(value, { max: { px: 200, em: 5, rem: 5, "%": 500 }, unitless: 5 }),
  "letter-spacing": (value) =>
    value === "normal" || isLength(value, { max: { px: 20, em: 1, rem: 1 } }),
  "margin-top": (value) => isLength(value, SPACING),
  "margin-bottom": (value) => isLength(value, SPACING),
  "margin-left": (value) => isLength(value, SPACING),
  "margin-right": (value) => isLength(value, SPACING),
  "padding-top": (value) => isLength(value, SPACING),
  "padding-bottom": (value) => isLength(value, SPACING),
  "padding-left": (value) => isLength(value, SPACING),
  "padding-right": (value) => isLength(value, SPACING),
  "border-radius": (value) => isLength(value, { max: { px: 64, em: 4, rem: 4, "%": 50 } }),
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
