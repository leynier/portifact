export interface CodeSampleProps {
  /** Names the sample for assistive technology, such as "Signature check in Node.js". */
  label: string;
  code: string;
}

/**
 * A short, read-only code sample in the monospace face, scrolling sideways on narrow screens. Its
 * region is focusable so keyboard users can scroll it; it never runs anything.
 */
export function CodeSample({ label, code }: CodeSampleProps) {
  return (
    <section
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
      tabIndex={0}
      className="min-w-0 max-w-full overflow-x-auto rounded-md border border-border bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      <p className="px-3 pt-2 text-xs text-text-muted">{label}</p>
      <pre className="p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </section>
  );
}
