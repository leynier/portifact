// What the CLI prints of text that comes from the server (artifact names, paths, comments):
// nothing that could drive the terminal or hide text. One place, used by every command.

/**
 * Removes what could change the terminal or hide text: control characters (C0, DEL and C1) other
 * than line feeds and tabs, line separators, and every invisible format character (`\p{Cf}`):
 * bidirectional overrides, isolates and marks (LRM, RLM, ALM), zero-width characters (ZWSP,
 * ZWNJ, and ZWJ too, so an emoji joined with it shows as its parts), the BOM, the soft hyphen and
 * tag characters.
 */
export function plain(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (character) =>
    character === "\n" || character === "\t" ? character : "",
  );
}

/** `plain`, on one line: line feeds and tabs become spaces (a name, a path, a label). */
export function oneLine(value: string): string {
  return plain(value).replace(/[\n\t]/g, " ");
}
