import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export interface DisclosureProps {
  /** What the hidden content is, always visible; it is the control's name. */
  summary: ReactNode;
  children: ReactNode;
  /** Starts open. */
  defaultOpen?: boolean;
  /** Called with the new state each time it opens or closes. */
  onToggle?(open: boolean): void;
  /**
   * `boxed` (the default) is a bordered box of its own; `inline` is a small link-like summary
   * with the content under it, for details inside a card that already has a frame.
   */
  appearance?: "boxed" | "inline";
  /**
   * Accessible name of the summary when the visible text repeats on the page, such as "Details"
   * on every card. It must start with the visible text.
   */
  label?: string;
}

/**
 * Content shown on demand: a native `details` element, so Enter and Space toggle it and
 * assistive technology reports whether it is expanded without any ARIA of our own.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  onToggle,
  appearance = "boxed",
  label,
}: DisclosureProps) {
  const chevron = (
    <span
      aria-hidden="true"
      className="inline-flex text-text-muted motion-safe:transition-transform group-open:rotate-90"
    >
      <ChevronRight className="size-4" />
    </span>
  );
  if (appearance === "inline") {
    return (
      <details
        open={defaultOpen}
        onToggle={(event) => onToggle?.(event.currentTarget.open)}
        className="group"
      >
        <summary
          aria-label={label}
          className="inline-flex h-8 items-center gap-1.5 rounded-xs pr-2 text-sm font-medium underline-offset-4 marker-none hover:underline"
        >
          {chevron}
          <span className="min-w-0 break-words">{summary}</span>
        </summary>
        <div className="pt-2">{children}</div>
      </details>
    );
  }
  return (
    <details
      open={defaultOpen}
      onToggle={(event) => onToggle?.(event.currentTarget.open)}
      className="group rounded-md border border-border bg-canvas"
    >
      <summary
        aria-label={label}
        className="flex items-center gap-2 rounded-md px-4 py-3 text-sm font-medium marker-none hover:bg-surface"
      >
        {chevron}
        <span className="min-w-0 break-words">{summary}</span>
      </summary>
      <div className="border-t border-border px-4 py-3">{children}</div>
    </details>
  );
}
