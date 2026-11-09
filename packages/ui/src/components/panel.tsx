import { type ReactNode, useId } from "react";

export interface PanelProps {
  title: string;
  /** Heading level, so the panel fits the outline of the page that holds it. */
  headingLevel?: 2 | 3;
  /** A line under the title: what the section is for, or the rule it follows. */
  description?: ReactNode;
  /** Controls for the whole section, such as export buttons. */
  actions?: ReactNode;
  /** An `id` for in-page links to this section, such as `/account#usage`. */
  id?: string;
  /** The body has no padding, for a flush table or list that runs to the edges. */
  flush?: boolean;
  children: ReactNode;
}

/**
 * A titled section of a screen on a raised surface. Screens stack panels on the backdrop instead
 * of drawing their own boxes, so every section has the same frame, heading and spacing.
 */
export function Panel({
  title,
  headingLevel = 2,
  description,
  actions,
  id,
  flush = false,
  children,
}: PanelProps) {
  const generated = useId();
  const headingId = `${id ?? generated}-heading`;
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section
      id={id}
      // A target of in-page links takes focus when a section guide follows one to it.
      tabIndex={id ? -1 : undefined}
      aria-labelledby={headingId}
      className="scroll-mt-32 rounded-lg border border-border bg-canvas shadow-sm focus:outline-none md:scroll-mt-20 xl:scroll-mt-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-5 pt-5">
        {/* The title keeps a readable width; on narrow screens the actions wrap below it. */}
        <div className="min-w-0 flex-1 basis-56">
          <Heading id={headingId} className="text-base font-semibold tracking-tight">
            {title}
          </Heading>
          {description ? (
            <div className="mt-1 max-w-3xl text-sm text-text-muted">{description}</div>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className={flush ? "mt-4 border-t border-border" : "px-5 pt-4 pb-5"}>{children}</div>
    </section>
  );
}
