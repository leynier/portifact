// How text from a suggestion is shown to a person (decision 0027, rule 7 of the second round).
// Text is split into typed tokens: literal text, and characters that a reader cannot see or could
// misread (default-ignorable code points, bidirectional controls, format and control characters,
// whitespace other than the plain space, and the two bracket characters this display uses, so
// that the literal text `⟦U+202E⟧` can never look like the real character). The viewer draws a
// character token as a distinct chip and each field in its own direction isolate (`<bdi>`); the
// string form below is what tests, logs and the agent's copy use. `inspect` lists code points for
// the person who wants to look closer, and hosts are shown in their canonical ASCII form.

export type DisplayToken = { kind: "text"; value: string } | { kind: "char"; codePoint: number };

/**
 * Characters shown as tokens. `\p{Default_Ignorable_Code_Point}` covers zero-width characters,
 * U+034F, variation selectors, tag characters and the bidirectional isolates and embeddings;
 * `\p{Bidi_Control}` and `\p{Cf}` add the marks and other format characters; whitespace other
 * than U+0020 and the display's own brackets complete it.
 */
const SPECIAL =
  /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Cf}\p{Cc}\p{Zl}\p{Zp}   -   　⟦⟧]/u;

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

/** Longest destination shown before an explicit omission marker. */
export const DESTINATION_MAX = 512;

/**
 * A link destination as the person sees it: the effective absolute URL (resolved against the
 * page's own URL on the artifact origin, with the host in its ASCII form, so a look-alike
 * Unicode host shows as `xn--…`) next to the spelling in the source.
 */
export interface Destination {
  authored: string;
  effective: string;
  /** Characters cut from each, shown as an explicit omission marker. */
  authoredOmitted: number;
  effectiveOmitted: number;
}

export function destination(authored: string, pageUrl: string): Destination {
  let effective: string;
  try {
    effective = new URL(authored, pageUrl).href;
  } catch {
    effective = "";
  }
  return {
    authored: authored.slice(0, DESTINATION_MAX),
    effective: effective.slice(0, DESTINATION_MAX),
    authoredOmitted: Math.max(0, authored.length - DESTINATION_MAX),
    effectiveOmitted: Math.max(0, effective.length - DESTINATION_MAX),
  };
}

/** An omission marker: never literal text, since `⟦` in text is always a character token. */
export const omitted = (count: number) => (count > 0 ? `⟦${count} characters omitted⟧` : "");
