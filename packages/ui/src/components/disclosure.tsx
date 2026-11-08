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
}

/**
 * Content shown on demand: a native `details` element, so Enter and Space toggle it and
 * assistive technology reports whether it is expanded without any ARIA of our own.
 */
export function Disclosure({ summary, children, defaultOpen = false, onToggle }: DisclosureProps) {
  return (
    <details
      open={defaultOpen}
      onToggle={(event) => onToggle?.(event.currentTarget.open)}
      className="group rounded-md border border-border"
    >
      <summary className="flex items-center gap-2 px-4 py-3 text-sm font-medium marker-none">
        <span
          aria-hidden="true"
          className="inline-flex text-text-muted motion-safe:transition-transform group-open:rotate-90"
        >
          <ChevronRight className="size-4" />
        </span>
        <span className="min-w-0 break-words">{summary}</span>
      </summary>
      <div className="border-t border-border px-4 py-3">{children}</div>
    </details>
  );
}
