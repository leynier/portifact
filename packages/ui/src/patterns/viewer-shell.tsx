import type { ReactNode } from "react";
import { Badge } from "../components/badge.tsx";

export interface ViewerShellProps {
  /** Text of the skip link that jumps to the artifact. */
  skipLinkLabel: string;
  /** The Portifact mark. */
  brand: ReactNode;
  /** Controls of the bar: sharing, the owner's links, the comments toggle and the account. */
  actions: ReactNode;
  /**
   * What the frame shows, attached to it rather than to the bar: the artifact's own origin, its
   * name as its publisher wrote it (the page's single `h1`, set as user content), short facts
   * such as the version, and a notice that a user published it, not Portifact.
   */
  caption: { origin: string; title: string; details?: ReactNode; notice: string };
  /** Accessible name of the artifact region. */
  frameLabel: string;
  /** Notices about the artifact and the artifact frame itself, which fills the region. */
  frame: ReactNode;
  /**
   * The comments sidebar: a complementary landmark beside the artifact on wide screens and
   * under it, as a bottom sheet sharing the screen, on narrow ones. Omit it to show none.
   */
  sidebar?: { id: string; label: string; content: ReactNode } | undefined;
}

/**
 * Page frame of the viewer with the Portifact bar: a slim bar with Portifact's mark and
 * controls, the artifact filling the rest of the screen under a caption that names its origin
 * and says a user published it, and an optional comments sidebar. The page itself never
 * scrolls; the frame and the sidebar scroll on their own. The artifact's name never sits next to
 * the mark, so a name such as "Portifact sign-in" cannot pass for Portifact's own page.
 */
export function ViewerShell({
  skipLinkLabel,
  brand,
  actions,
  caption,
  frameLabel,
  frame,
  sidebar,
}: ViewerShellProps) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-text">
      <a
        href="#artifact"
        className="sr-only z-50 rounded-sm bg-surface-inverse px-3 py-2 text-text-inverse focus:not-sr-only focus:fixed focus:top-4 focus:left-4"
      >
        {skipLinkLabel}
      </a>
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border-strong bg-surface px-3 py-2">
        <div className="flex h-9 shrink-0 items-center">{brand}</div>
        <div className="flex flex-wrap items-center gap-2 text-sm">{actions}</div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main
          id="artifact"
          tabIndex={-1}
          aria-label={frameLabel}
          className="flex min-h-0 min-w-0 flex-1 flex-col focus:outline-none"
        >
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-canvas px-3 py-2 text-sm">
            <span className="min-w-0 font-mono break-all text-text-muted">{caption.origin}</span>
            <h1 className="min-w-0 truncate font-normal">
              <span aria-hidden="true">“</span>
              {caption.title}
              <span aria-hidden="true">”</span>
            </h1>
            {caption.details}
            <Badge emphasis="strong">{caption.notice}</Badge>
          </div>
          {frame}
        </main>
        {sidebar ? (
          <aside
            id={sidebar.id}
            aria-label={sidebar.label}
            className="flex h-1/2 min-h-0 shrink-0 flex-col overflow-y-auto border-t border-border-strong bg-surface lg:h-auto lg:w-96 lg:border-t-0 lg:border-l"
          >
            <div className="flex flex-col gap-4 p-4">{sidebar.content}</div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
