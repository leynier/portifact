// What the CLI prints of text that comes from the server (artifact names, paths, comments):
// nothing that could drive the terminal or hide text. One place, used by every command.

/**
 * Removes what could change the terminal or hide text: control characters (C0, DEL and C1)
 * other than line feeds and tabs, line separators and bidirectional overrides and isolates.
 */
export function plain(value: string): string {
  return value.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, (character) =>
    character === "\n" || character === "\t" ? character : "",
  );
}

/** `plain`, on one line: line feeds and tabs become spaces (a name, a path, a label). */
export function oneLine(value: string): string {
  return plain(value).replace(/[\n\t]/g, " ");
}
