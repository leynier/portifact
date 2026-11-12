// How text from a suggestion is shown to a person (decision 0027, "What the person is shown").
// Text is split into typed tokens: literal text, and characters a reader cannot see or could
// misread (default-ignorable code points, bidirectional controls, format and control characters,
// whitespace other than the plain space, and the two brackets this display uses, so the literal
// text `⟦U+202E⟧` can never look like the real character). The viewer draws a character token as
// a chip and each field in its own direction isolate; the string form is what the confirmation's
// lines, the change list and the agent's copy use. Hosts are shown in their ASCII form.
import type { Destination } from "@portifact/contracts";

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

/** Where an attribute's value sits in a stored file. */
export type DestinationAt = Destination["at"];

/**
 * A link destination as the person sees it: the effective absolute URL, resolved against the
 * page's base URL (the URL parser writes the host in ASCII, so a look-alike Unicode host shows as
 * `xn--…`), next to the spelling in the source, both whole. `resolved` is false when there is no
 * base to resolve against or the URL parser refuses the value.
 */
export function destination(authored: string, base: string | null, at: DestinationAt): Destination {
  let effective = "";
  let resolved = base !== null;
  if (base !== null) {
    try {
      effective = new URL(authored, base).href;
    } catch {
      resolved = false;
    }
  }
  return { authored, effective, resolved, authoredOmitted: 0, effectiveOmitted: 0, at };
}

/** A destination shortened to `max` units on each value, the omission marked. */
export function shortenDestination(link: Destination, max: number): Destination {
  const cut = (value: string, omitted: number) => ({
    value: value.slice(0, max),
    omitted: omitted + Math.max(0, value.length - max),
  });
  const authored = cut(link.authored, link.authoredOmitted);
  const effective = cut(link.effective, link.effectiveOmitted);
  return {
    ...link,
    authored: authored.value,
    authoredOmitted: authored.omitted,
    effective: effective.value,
    effectiveOmitted: effective.omitted,
  };
}

/** An omission marker: never literal text, since `⟦` in text is always a character token. */
export const omitted = (count: number): string =>
  count > 0 ? `⟦${count} characters omitted⟧` : "";
