import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  icon?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  /** Heading level, so the empty state fits the outline of the page that holds it. */
  headingLevel?: 2 | 3;
}

/**
 * What a screen or section shows when it has nothing yet. It teaches: say what will appear here
 * and how to make it appear, with the action at hand.
 */
export function EmptyState({ title, icon, children, action, headingLevel = 2 }: EmptyStateProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className="rounded-lg border border-dashed border-border-strong bg-canvas px-5 py-8 sm:px-8 sm:py-10">
      {icon ? (
        <span
          aria-hidden="true"
          className="inline-flex size-11 items-center justify-center rounded-md bg-selection text-text"
        >
          {icon}
        </span>
      ) : null}
      <Heading className={`${icon ? "mt-4" : ""} text-lg font-semibold tracking-tight`}>
        {title}
      </Heading>
      {children ? <div className="mt-1.5 max-w-2xl text-sm text-text-muted">{children}</div> : null}
      {action ? <div className="mt-6 flex flex-wrap gap-3">{action}</div> : null}
    </section>
  );
}
