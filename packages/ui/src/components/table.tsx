import { createContext, type ReactNode, useContext } from "react";

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
  /**
   * Below the `sm` breakpoint, each row becomes a stack of its cells instead of a line of a
   * table that scrolls sideways: the header row is hidden and cells with a `label` show it above
   * their value. The table keeps explicit table roles, because some browsers drop a table's
   * semantics when its display changes, so assistive technology still reads rows and columns.
   */
  stacked?: boolean;
  children: ReactNode;
}

const Stacked = createContext(false);

/** The explicit role of a table element, set only when its display may change. */
const role = (stacked: boolean, name: string) => (stacked ? { role: name } : {});

/**
 * A data table that scrolls inside its own focusable region on narrow screens, so the page
 * itself never scrolls sideways, or that stacks its rows there (`stacked`). The region is
 * positioned, so visually hidden text in a cell (absolutely positioned) stays inside it instead
 * of widening the page.
 */
export function Table({
  caption,
  captionVisible = false,
  variant = "framed",
  stacked = false,
  children,
}: TableProps) {
  const frame =
    variant === "framed"
      ? "relative overflow-x-auto rounded-lg border border-border bg-canvas"
      : "relative overflow-x-auto";
  return (
    <Stacked.Provider value={stacked}>
      <section
        aria-label={caption}
        // A scrolling region must be reachable by keyboard; a stacked one never scrolls.
        tabIndex={stacked ? undefined : 0}
        className={stacked ? frame.replace("overflow-x-auto", "sm:overflow-x-auto") : frame}
      >
        <table
          {...role(stacked, "table")}
          className={`w-full border-collapse text-left text-sm ${stacked ? "max-sm:block" : ""}`}
        >
          <caption className={captionVisible ? "px-4 py-3 text-left font-semibold" : "sr-only"}>
            {caption}
          </caption>
          {children}
        </table>
      </section>
    </Stacked.Provider>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  const stacked = useContext(Stacked);
  return (
    <thead
      {...role(stacked, "rowgroup")}
      className={`border-b border-border bg-surface ${stacked ? "max-sm:sr-only" : ""}`}
    >
      {children}
    </thead>
  );
}

export function TableBody({ children }: { children: ReactNode }) {
  const stacked = useContext(Stacked);
  return (
    <tbody
      {...role(stacked, "rowgroup")}
      className={`divide-y divide-border ${stacked ? "max-sm:block" : ""}`}
    >
      {children}
    </tbody>
  );
}

export interface TableRowProps {
  /**
   * The whole row opens what it names: one link in it carries `rowLinkClasses`, which stretches
   * its press area over the row (the stretched-link pattern), so the row stays a plain row for
   * assistive technology, the link keeps working with the keyboard, a middle click and "open in
   * new tab", and nothing interactive is nested. Other controls in the row take
   * `rowControlClasses` to stay above it.
   */
  linked?: boolean;
  children: ReactNode;
}

export function TableRow({ linked = false, children }: TableRowProps) {
  const stacked = useContext(Stacked);
  const hover = linked
    ? "relative focus-within:bg-surface-hover hover:bg-surface-hover"
    : "hover:bg-surface";
  return (
    <tr
      {...role(stacked, "row")}
      className={`transition-colors duration-150 ${hover} ${stacked ? "max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-2 max-sm:px-4 max-sm:py-3.5" : ""}`}
    >
      {children}
    </tr>
  );
}

/** The link that opens a `linked` row: its press area covers the whole row. */
export const rowLinkClasses =
  "no-underline after:absolute after:inset-0 hover:underline focus-visible:underline";

/** A control inside a `linked` row, kept above the row's link so it gets its own presses. */
export const rowControlClasses = "relative z-10";

export function TableHeaderCell({ children }: { children: ReactNode }) {
  const stacked = useContext(Stacked);
  return (
    <th
      scope="col"
      {...role(stacked, "columnheader")}
      className="h-10 px-4 text-xs font-medium whitespace-nowrap text-text-muted first:pl-5 last:pr-5"
    >
      {children}
    </th>
  );
}

/**
 * The header of a row, such as the limit a comparison row shows: the first cell of the row,
 * which assistive technology reads before each value of the row.
 */
export function TableRowHeader({ children }: { children: ReactNode }) {
  const stacked = useContext(Stacked);
  return (
    <th
      scope="row"
      {...role(stacked, "rowheader")}
      className={`px-4 py-3.5 text-left align-middle font-medium first:pl-5 last:pr-5 ${stacked ? STACK.full : ""}`}
    >
      {children}
    </th>
  );
}

export interface TableCellProps {
  /**
   * The column's name, shown above the value while a `stacked` table stacks its rows. Leave it
   * out where the value says what it is, such as a badge.
   */
  label?: string;
  /**
   * How the cell sits in a stacked row: `full` takes a line of its own (the default), `inline`
   * shares the line with its neighbours, such as badges, and `end` goes to the end of the line,
   * such as the row's actions.
   */
  stack?: "full" | "inline" | "end";
  children: ReactNode;
}

const STACK = {
  full: "max-sm:block max-sm:w-full max-sm:p-0 max-sm:first:pl-0 max-sm:last:pr-0",
  inline: "max-sm:block max-sm:p-0 max-sm:first:pl-0 max-sm:last:pr-0",
  end: "max-sm:ml-auto max-sm:block max-sm:p-0 max-sm:first:pl-0 max-sm:last:pr-0",
} as const;

export function TableCell({ label, stack = "full", children }: TableCellProps) {
  const stacked = useContext(Stacked);
  return (
    <td
      {...role(stacked, "cell")}
      className={`px-4 py-3.5 align-middle first:pl-5 last:pr-5 ${stacked ? STACK[stack] : ""}`}
    >
      {stacked && label ? (
        // The column header names the cell for assistive technology; this is for the eye.
        <span aria-hidden="true" className="block text-xs text-text-muted sm:hidden">
          {label}
        </span>
      ) : null}
      {children}
    </td>
  );
}
