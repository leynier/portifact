// How text from a suggestion is shown to a person (decision 0027, "What the person is shown").
// Text is split into typed tokens: literal text, and characters a reader cannot see or could
// misread (default-ignorable code points, bidirectional controls, format and control characters,
// whitespace other than the plain space, and the two brackets this display uses, so the literal
// text `⟦U+202E⟧` can never look like the real character). The viewer draws a character token as
// a chip and each field in its own direction isolate; the string form is what the confirmation's
// lines, the change list and the agent's copy use. Hosts are shown in their ASCII form.
import { type Destination, PLAN_LIMITS } from "@portifact/contracts";

export type DisplayToken = { kind: "text"; value: string } | { kind: "char"; codePoint: number };

const SPECIAL =
  /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Cf}\p{Cc}\p{Zl}\p{Zp}   -   　⟦⟧]/u;

/** Whether a character is shown as a token. */
export const isSpecialCharacter = (char: string): boolean => SPECIAL.test(char);

export function tokens(text: string): DisplayToken[] {
  const found: DisplayToken[] = [];
  let literal = "";
  for (const char of text) {
    if (SPECIAL.test(char)) {
      if (literal) found.push({ kind: "text", value: literal });
      literal = "";
      found.push({ kind: "char", codePoint: char.codePointAt(0) as number });
    } else {
      literal += char;
    }
  }
  if (literal) found.push({ kind: "text", value: literal });
  return found;
}

const hex = (codePoint: number) => codePoint.toString(16).toUpperCase().padStart(4, "0");

/** The string form: a character token is `⟦U+XXXX⟧`, which literal text can never produce. */
export function visible(text: string): string {
  return tokens(text)
    .map((token) => (token.kind === "text" ? token.value : `⟦U+${hex(token.codePoint)}⟧`))
    .join("");
}

/** Every code point of a field, for the inspection panel. */
export function inspect(text: string): string[] {
  return Array.from(text, (char) => `U+${hex(char.codePointAt(0) as number)}`);
}

/**
 * A link destination as the person sees it: the effective absolute URL, resolved against the
 * page's own URL on the artifact origin (the URL parser writes the host in ASCII, so a look-alike
 * Unicode host shows as `xn--…`), next to the spelling in the source, each bounded.
 */
export function destination(authored: string, pageUrl: string): Destination {
  let effective: string;
  try {
    effective = new URL(authored, pageUrl).href;
  } catch {
    effective = "";
  }
  const max = PLAN_LIMITS.destinationUnits;
  return {
    authored: authored.slice(0, max),
    effective: effective.slice(0, max),
    authoredOmitted: Math.max(0, authored.length - max),
    effectiveOmitted: Math.max(0, effective.length - max),
  };
}

/** An omission marker: never literal text, since `⟦` in text is always a character token. */
export const omitted = (count: number): string =>
  count > 0 ? `⟦${count} characters omitted⟧` : "";
