import { type ReactNode, useEffect, useId, useState } from "react";

export interface PageSectionLink {
  id: string;
  label: string;
}

export interface SectionedPageProps {
  /** Accessible name of the in-page navigation, such as "Artifact sections". */
  label: string;
  sections: readonly PageSectionLink[];
  /** The `PageSection`s, in the order of `sections`. */
  children: ReactNode;
}

/**
 * A long screen split into sections with an in-page navigation beside them: a sticky column on
 * wide screens and a wrapping row above the content on narrow ones. The link of the section
 * being read is drawn as a selection, in bold, with `aria-current`.
 */
export function SectionedPage({ label, sections, children }: SectionedPageProps) {
  const ids = sections.map((section) => section.id).join(" ");
  const [current, setCurrent] = useState(sections[0]?.id);

  useEffect(() => {
    if (typeof IntersectionObserver !== "function") return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
          else visible.delete(entry.target.id);
        }
        // The topmost section in the upper part of the window is the one being read.
        const top = ids.split(" ").find((id) => visible.has(id));
        if (top) setCurrent(top);
      },
      { rootMargin: "0px 0px -55% 0px" },
    );
    for (const id of ids.split(" ")) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [ids]);

  return (
    <div className="grid items-start gap-8 lg:grid-cols-5">
      <nav aria-label={label} className="lg:sticky lg:top-10">
        <ul className="flex flex-wrap gap-x-2 gap-y-2 text-sm lg:flex-col lg:gap-1.5">
          {sections.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                aria-current={section.id === current ? "true" : undefined}
                onClick={() => setCurrent(section.id)}
                className="flex h-8 items-center rounded-xs px-2.5 text-text-muted no-underline transition-colors duration-150 hover:bg-surface-hover hover:text-text current-item:font-semibold current-item:text-text current-item:selection-band current-item:hover:bg-selection"
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-col gap-10 lg:col-span-4">{children}</div>
    </div>
  );
}

export interface PageSectionProps {
  /** Target of the in-page navigation's link. */
  id: string;
  title: string;
  /** A line under the title. */
  description?: ReactNode;
  /** `danger` marks a section of destructive actions, such as deleting: a dashed rule above. */
  tone?: "normal" | "danger";
  /** The section's panels, with `headingLevel={3}`. */
  children: ReactNode;
}

/** One task of a sectioned screen: an `h2` and the panels that belong to it. */
export function PageSection({
  id,
  title,
  description,
  tone = "normal",
  children,
}: PageSectionProps) {
  const headingId = `${useId()}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={`flex scroll-mt-6 flex-col gap-4 ${tone === "danger" ? "border-t border-dashed border-border-strong pt-8" : ""}`}
    >
      <div>
        <h2 id={headingId} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {description ? (
          <div className="mt-1 max-w-3xl text-sm text-text-muted">{description}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}
