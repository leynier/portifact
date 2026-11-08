import type { ReactNode } from "react";

export interface DetailItem {
  term: string;
  detail: ReactNode;
}

/** Labelled facts about one object, as a description list. */
export function DetailList({ items }: { items: readonly DetailItem[] }) {
  return (
    <dl className="divide-y divide-border rounded-md border border-border">
      {items.map((item) => (
        <div key={item.term} className="grid gap-1 px-4 py-3 sm:grid-cols-3 sm:gap-4">
          <dt className="text-sm text-text-muted">{item.term}</dt>
          <dd className="min-w-0 text-sm break-words sm:col-span-2">{item.detail}</dd>
        </div>
      ))}
    </dl>
  );
}
