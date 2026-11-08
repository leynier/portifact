import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  icon?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  /** Heading level, so the empty state fits the outline of the page that holds it. */
  headingLevel?: 2 | 3;
}

export function EmptyState({ title, icon, children, action, headingLevel = 2 }: EmptyStateProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className="rounded-lg border border-dashed border-border-strong px-6 py-12 text-center">
      {icon ? (
        <span aria-hidden="true" className="inline-flex text-text-muted">
          {icon}
        </span>
      ) : null}
      <Heading className="mt-3 text-lg font-semibold">{title}</Heading>
      {children ? (
        <div className="mx-auto mt-2 max-w-md text-sm text-text-muted">{children}</div>
      ) : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </section>
  );
}
