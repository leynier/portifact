import type { ReactNode } from "react";

export interface ViewerShellProps {
  /** Text of the skip link that jumps to the artifact. */
  skipLinkLabel: string;
  /** The Portifact mark. */
  brand: ReactNode;
  /** Controls of the bar: copying the link, the owner's links, the comments toggle, the account. */
  actions: ReactNode;
  /**
   * What the frame shows, in the bar after the mark: its name as its publisher wrote it (the
   * page's single `h1`, set as plain user text, never as a Portifact heading) and short facts
   * such as the version.
   */
  artifact: { title: string; details?: ReactNode };
  /** Accessible name of the artifact region. */
  frameLabel: string;
  /** Notices about the artifact and the artifact frame itself, which fills the panel. */
  frame: ReactNode;
  /**
   * The comments sidebar: a complementary landmark beside the artifact on wide screens and
   * under it, as a bottom sheet sharing the screen, on narrow ones. Omit it to show none.
   */
  sidebar?: { id: string; label: string; content: ReactNode } | undefined;
}

/**
 * Page frame of the viewer with the Portifact bar: a slim bar with Portifact's mark, the
 * artifact's name and version as plain text past a divider, and the controls; the artifact in a
 * bordered panel on the backdrop, so its content never reads as part of the bar; and an optional
 * comments sidebar. The page itself never scrolls; the frame and the sidebar scroll on their own.
 */
export function ViewerShell({
  skipLinkLabel,
  brand,
  actions,
  artifact,
  frameLabel,
  frame,
  sidebar,
}: ViewerShellProps) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-backdrop text-text">
      <a
        href="#artifact"
        className="sr-only z-50 rounded-sm bg-surface-inverse px-3 py-2 text-text-inverse focus:not-sr-only focus:fixed focus:top-4 focus:left-4"
      >
        {skipLinkLabel}
      </a>
      <header className="relative z-10 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-canvas px-3 py-2 shadow-sm sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-9 shrink-0 items-center">{brand}</div>
          <div className="flex min-w-0 items-center gap-2 border-l border-border pl-3">
            <h1 title={artifact.title} className="min-w-0 truncate text-sm font-normal">
              {artifact.title}
            </h1>
            {artifact.details}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-sm">{actions}</div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main
          id="artifact"
          tabIndex={-1}
          aria-label={frameLabel}
          className="flex min-h-0 min-w-0 flex-1 flex-col p-2 focus:outline-none sm:p-3"
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-strong bg-canvas shadow-sm">
            {frame}
          </div>
        </main>
        {sidebar ? (
          <aside
            id={sidebar.id}
            aria-label={sidebar.label}
            className="flex h-1/2 min-h-0 shrink-0 flex-col overflow-y-auto border-t border-border bg-backdrop lg:h-auto lg:w-96 lg:border-t-0 lg:border-l"
          >
            <div className="flex flex-col gap-4 p-4">{sidebar.content}</div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
