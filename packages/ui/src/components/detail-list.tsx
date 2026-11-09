import type { ReactNode } from "react";

export interface DetailItem {
  term: string;
  detail: ReactNode;
}

export interface DetailListProps {
  items: readonly DetailItem[];
  /**
   * `split` puts the term beside the detail on wide screens; `stacked` puts it above, for narrow
   * columns such as a side panel.
   */
  layout?: "split" | "stacked";
  /** Draws its own border; turn it off inside a panel that has one. */
  framed?: boolean;
}

/** Labelled facts about one object, as a description list. */
export function DetailList({ items, layout = "split", framed = true }: DetailListProps) {
  const frame = framed ? "rounded-lg border border-border bg-canvas" : "";
  const row =
    layout === "split"
      ? "grid gap-1 px-4 py-3 sm:grid-cols-3 sm:gap-4"
      : "flex flex-col gap-0.5 py-3 first:pt-0 last:pb-0";
  return (
    <dl className={`divide-y divide-border ${frame}`}>
      {items.map((item) => (
        <div key={item.term} className={row}>
          <dt
            className={layout === "split" ? "text-sm text-text-muted" : "text-xs text-text-muted"}
          >
            {item.term}
          </dt>
          <dd
            className={`min-w-0 text-sm break-words tabular-nums ${layout === "split" ? "sm:col-span-2" : ""}`}
          >
            {item.detail}
          </dd>
        </div>
      ))}
    </dl>
  );
}
