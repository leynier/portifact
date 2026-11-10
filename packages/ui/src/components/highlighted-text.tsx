export interface HighlightedTextProps {
  /** Plain text, rendered as text: never parsed as markup. */
  text: string;
  /** Parts to mark, `[start, end)` in UTF-16 code units; out of range or overlapping parts are dropped. */
  ranges: readonly (readonly [number, number])[];
}

/** The parts of `text` between `ranges`, in order, each marked or not. */
export function highlightParts(
  text: string,
  ranges: readonly (readonly [number, number])[],
): { text: string; marked: boolean }[] {
  const parts: { text: string; marked: boolean }[] = [];
  let at = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (start < at || start >= end || end > text.length) continue;
    if (start > at) parts.push({ text: text.slice(at, start), marked: false });
    parts.push({ text: text.slice(start, end), marked: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), marked: false });
  return parts;
}

/**
 * Text with some parts highlighted, such as the words a search found in a snippet. The marks use
 * the selection band's color behind the text's own color, so they read in both themes and never
 * depend on color alone: `<mark>` carries the meaning.
 */
export function HighlightedText({ text, ranges }: HighlightedTextProps) {
  return (
    <>
      {highlightParts(text, ranges).map((part, index) =>
        part.marked ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
          <mark key={index} className="rounded-xs bg-highlight font-semibold text-text">
            {part.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
