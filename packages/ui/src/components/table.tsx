import type { ReactNode } from "react";

export interface TableProps {
  /** Names the table and the scrolling region that holds it. */
  caption: string;
  /** Show the caption to everyone, or only to assistive technology. */
  captionVisible?: boolean;
  /**
   * `framed` draws its own border and background; `flush` sits inside a panel that already has
   * them, so the table never draws a box inside a box.
   */
  variant?: "framed" | "flush";
  children: ReactNode;
}

/**
 * A data table that scrolls inside its own focusable region on narrow screens, so the page
 * itself never scrolls sideways. The region is positioned, so visually hidden text in a cell
 * (absolutely positioned) stays inside it instead of widening the page.
 */
export function Table({
  caption,
  captionVisible = false,
  variant = "framed",
  children,
}: TableProps) {
  return (
    <section
      aria-label={caption}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
      tabIndex={0}
      className={
        variant === "framed"
          ? "relative overflow-x-auto rounded-lg border border-border bg-canvas"
          : "relative overflow-x-auto"
      }
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
  return <tr className="transition-colors duration-150 hover:bg-surface">{children}</tr>;
}

export function TableHeaderCell({ children }: { children: ReactNode }) {
  return (
    <th
      scope="col"
      className="h-10 px-4 text-xs font-medium whitespace-nowrap text-text-muted first:pl-5 last:pr-5"
    >
      {children}
    </th>
  );
}

export function TableCell({ children }: { children: ReactNode }) {
  return <td className="px-4 py-3.5 align-middle first:pl-5 last:pr-5">{children}</td>;
}
