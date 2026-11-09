import { ChevronDown, ListTree } from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useMediaQuery } from "../hooks/use-media-query.ts";

/** Tailwind's `xl` breakpoint: from here the section guide is a column at the end of the page. */
export const GUIDE_QUERY = "(min-width: 80rem)";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Keys that scroll the page; pressing one hands the guide back to the scroll spy. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export interface PageSectionLink {
  id: string;
  label: string;
}

export interface SectionedPageProps {
  /** Accessible name of the in-page navigation, such as "Artifact sections". */
  label: string;
  /** The guide's visible title, such as "On this page". */
  title: string;
  sections: readonly PageSectionLink[];
  /** The `PageSection`s, in the order of `sections`. */
  children: ReactNode;
}

const linkClasses =
  "flex min-h-8 items-center rounded-xs px-2.5 py-1 text-text-muted no-underline transition-colors duration-150 hover:bg-surface-hover hover:text-text current-item:font-semibold current-item:text-text current-item:selection-band current-item:hover:bg-selection";

function initialSection(sections: readonly PageSectionLink[]): string | undefined {
  const hash = typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash);
  const fromHash = sections.find((section) => `#${section.id}` === hash);
  return fromHash?.id ?? sections[0]?.id;
}

const matches = (query: string) =>
  typeof window.matchMedia === "function" && window.matchMedia(query).matches;

/**
 * A long screen split into sections with a guide to them ("On this page"). On wide screens
 * (`GUIDE_QUERY`) the guide is a sticky column at the end, so the content starts next to the app
 * sidebar and takes the free space; on narrower ones it is a compact menu that stays at the top
 * while the page scrolls. The link of the section being read (an `IntersectionObserver` scroll
 * spy, and the last section once the page is scrolled to its end) is drawn as a selection, in
 * bold, with `aria-current`. Following a link scrolls smoothly unless reduced motion is asked for,
 * and moves focus to the section.
 */
export function SectionedPage({ label, title, sections, children }: SectionedPageProps) {
  const ids = sections.map((section) => section.id).join(" ");
  const [current, setCurrent] = useState(() => initialSection(sections));
  const [menuOpen, setMenuOpen] = useState(false);
  const wide = useMediaQuery(GUIDE_QUERY);
  // A followed link stays current until the person scrolls themselves, even when its section
  // is too close to the end of the page to reach the top.
  const pinned = useRef(false);

  useEffect(() => {
    if (typeof IntersectionObserver !== "function") return;
    const order = ids.split(" ");
    const visible = new Set<string>();
    const pick = () => {
      if (pinned.current) return;
      const root = document.documentElement;
      // A short last section never reaches the upper part of the window: at the end of the
      // page, it is the one being read.
      const atEnd =
        window.scrollY > 0 && window.innerHeight + window.scrollY >= root.scrollHeight - 2;
      const last = order[order.length - 1];
      if (atEnd && last) return setCurrent(last);
      // The topmost section in the upper part of the window is the one being read.
      const top = order.find((id) => visible.has(id));
      if (top) setCurrent(top);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        pick();
      },
      { rootMargin: "0px 0px -55% 0px" },
    );
    for (const id of order) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(pick);
    };
    const release = (event: Event) => {
      if (event instanceof KeyboardEvent && !SCROLL_KEYS.has(event.key)) return;
      pinned.current = false;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    for (const type of ["wheel", "touchmove", "keydown"]) {
      window.addEventListener(type, release, { passive: true });
    }
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      for (const type of ["wheel", "touchmove", "keydown"]) {
        window.removeEventListener(type, release);
      }
      cancelAnimationFrame(frame);
    };
  }, [ids]);

  const follow = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    setCurrent(id);
    setMenuOpen(false);
    // Opening in a new tab or window keeps the browser's own behavior.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    pinned.current = true;
    target.scrollIntoView?.({
      behavior: matches(REDUCED_MOTION) ? "auto" : "smooth",
      block: "start",
    });
    target.focus({ preventScroll: true });
    // Keep the address shareable without a router navigation.
    window.history.replaceState(window.history.state, "", `#${id}`);
  };

  const links = (
    <ul className="flex flex-col gap-1 text-sm">
      {sections.map((section) => (
        <li key={section.id}>
          <a
            href={`#${section.id}`}
            aria-current={section.id === current ? "true" : undefined}
            onClick={(event) => follow(event, section.id)}
            className={linkClasses}
          >
            {section.label}
          </a>
        </li>
      ))}
    </ul>
  );
  const currentLabel = sections.find((section) => section.id === current)?.label;

  return (
    <div className="grid items-start gap-6 xl:grid-cols-guide xl:gap-10">
      {wide ? (
        <nav aria-label={label} className="sticky top-10 xl:col-start-2 xl:row-start-1">
          <p className="mb-2 px-2.5 text-xs font-medium text-text-muted">{title}</p>
          {links}
        </nav>
      ) : (
        <nav aria-label={label} className="sticky top-16 z-20 md:top-4">
          <details
            open={menuOpen}
            onToggle={(event) => setMenuOpen(event.currentTarget.open)}
            className="group rounded-md border border-border bg-canvas shadow-sm"
          >
            <summary className="flex h-11 items-center gap-2 rounded-md px-3 text-sm marker-none hover:bg-surface-hover">
              <span aria-hidden="true" className="inline-flex text-text-muted">
                <ListTree className="size-4" />
              </span>
              <span className="shrink-0 text-text-muted">{title}</span>
              {currentLabel ? (
                <span className="min-w-0 truncate font-medium">{currentLabel}</span>
              ) : null}
              <span
                aria-hidden="true"
                className="ml-auto inline-flex text-text-muted motion-safe:transition-transform group-open:rotate-180"
              >
                <ChevronDown className="size-4" />
              </span>
            </summary>
            <div className="border-t border-border p-1.5">{links}</div>
          </details>
        </nav>
      )}
      <div className="flex min-w-0 flex-col gap-10 xl:col-start-1 xl:row-start-1">{children}</div>
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

/**
 * One task of a sectioned screen: an `h2` and the panels that belong to it. It takes focus (not
 * in the tab order) when the guide's link to it is followed.
 */
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
      tabIndex={-1}
      aria-labelledby={headingId}
      className={`flex scroll-mt-32 flex-col gap-4 focus:outline-none md:scroll-mt-20 xl:scroll-mt-6 ${tone === "danger" ? "border-t border-dashed border-border-strong pt-8" : ""}`}
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
