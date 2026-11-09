import { X } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { IconButton } from "../components/icon-button.tsx";

export interface ViewerShellProps {
  /** Text of the skip link that jumps to the artifact. */
  skipLinkLabel: string;
  /** The Portifact mark. */
  brand: ReactNode;
  /**
   * Controls about the artifact, shown from the `sm` breakpoint: icon buttons for copying the
   * link and the owner's settings or the report link.
   */
  actions: ReactNode;
  /** The comments toggle, shown at every width. */
  toggle?: ReactNode;
  /** Controls about the visitor after a divider, from `sm`: the dashboard and the account. */
  account?: ReactNode;
  /** Below `sm`, one overflow menu holds what `actions` and `account` hold on wider screens. */
  overflow?: ReactNode;
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
   * The comments sidebar: a complementary landmark beside the artifact on wide screens, and a
   * panel over the artifact below `lg`, closed with `closeLabel`'s button. Omit it to show none.
   */
  sidebar?:
    | {
        id: string;
        label: string;
        content: ReactNode;
        closeLabel: string;
        onClose(): void;
        ref?: Ref<HTMLElement>;
      }
    | undefined;
}

/**
 * Page frame of the viewer with the Portifact bar: a slim bar with Portifact's mark, the
 * artifact's name and version as plain text past a divider, and the controls; the artifact edge
 * to edge below the bar's border and shadow, which keep it apart from the bar; and an optional
 * comments sidebar. The page itself never scrolls; the frame and the sidebar scroll on their own.
 * On narrow screens the bar keeps the mark, the name, the comments toggle and an overflow menu,
 * and the sidebar covers the artifact instead of squeezing it.
 */
export function ViewerShell({
  skipLinkLabel,
  brand,
  actions,
  toggle,
  account,
  overflow,
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
      <header className="relative z-30 flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-canvas px-2 shadow-sm sm:gap-3 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          <div className="flex h-9 shrink-0 items-center">{brand}</div>
          <div className="flex min-w-0 items-center gap-2 border-l border-border pl-2 sm:pl-3">
            <h1 title={artifact.title} className="min-w-0 truncate text-sm font-normal">
              {artifact.title}
            </h1>
            {artifact.details ? (
              <span className="max-sm:sr-only inline-flex shrink-0">{artifact.details}</span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-sm sm:gap-1.5">
          <div className="hidden items-center gap-1 sm:flex">{actions}</div>
          {toggle}
          {overflow ? <div className="flex sm:hidden">{overflow}</div> : null}
          {account ? (
            <div className="ml-1 hidden items-center gap-1.5 border-l border-border pl-2.5 sm:flex">
              {account}
            </div>
          ) : null}
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
        <main
          id="artifact"
          tabIndex={-1}
          aria-label={frameLabel}
          className="flex min-h-0 min-w-0 flex-1 flex-col focus:outline-none"
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">{frame}</div>
        </main>
        {sidebar ? (
          <aside
            ref={sidebar.ref}
            id={sidebar.id}
            aria-label={sidebar.label}
            tabIndex={-1}
            className="absolute inset-0 z-20 flex min-h-0 flex-col overflow-y-auto bg-backdrop focus:outline-none lg:static lg:z-auto lg:w-96 lg:shrink-0 lg:border-l lg:border-border"
          >
            <div className="sticky top-0 z-10 flex justify-end border-b border-border bg-canvas px-2 py-1 lg:hidden">
              <IconButton
                label={sidebar.closeLabel}
                icon={<X className="size-4" />}
                align="end"
                onClick={sidebar.onClose}
              />
            </div>
            <div className="flex flex-col gap-4 p-4">{sidebar.content}</div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
