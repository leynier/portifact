import type { ReactNode } from "react";

export interface TableProps {
  /** Names the table and the scrolling region that holds it. */
  caption: string;
  /** Show the caption to everyone, or only to assistive technology. */
  captionVisible?: boolean;
  children: ReactNode;
}

/**
 * A data table that scrolls inside its own focusable region on narrow screens, so the page
 * itself never scrolls sideways.
 */
export function Table({ caption, captionVisible = false, children }: TableProps) {
  return (
    <section
      aria-label={caption}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
      tabIndex={0}
      className="overflow-x-auto rounded-md border border-border"
    >
      <table className="w-full border-collapse text-left text-sm">
        <caption className={captionVisible ? "px-4 py-3 text-left font-semibold" : "sr-only"}>
          {caption}
        </caption>
        {children}
      </table>
    </section>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-border bg-surface">{children}</thead>;
}

export function TableBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-border">{children}</tbody>;
}

export function TableRow({ children }: { children: ReactNode }) {
  return <tr>{children}</tr>;
}

export function TableHeaderCell({ children }: { children: ReactNode }) {
  return (
    <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap text-text-muted">
      {children}
    </th>
  );
}

export function TableCell({ children }: { children: ReactNode }) {
  return <td className="px-4 py-3 align-middle">{children}</td>;
}
