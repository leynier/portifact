import type { ReactNode } from "react";

export interface AppShellProps {
  /** Text of the skip link that jumps to the main content. */
  skipLinkLabel: string;
  /** Accessible name of the primary navigation landmark. */
  navigationLabel: string;
  /** The logo, linking home. */
  brand: ReactNode;
  /** Links of the primary navigation, one per item. */
  navigation: ReactNode[];
  /** Something to keep in sight under the navigation, such as the account's usage. */
  aside?: ReactNode;
  /** The signed-in account and its controls, such as sign out. */
  account: ReactNode;
  children: ReactNode;
}

/**
 * Page frame of the dashboard: a skip link, a banner with the brand, the primary navigation and
 * the account, and one main landmark that receives focus from the skip link. On wide screens the
 * banner is a fixed sidebar; on narrow ones it is a bar above the content whose navigation wraps.
 * Screens sit on the backdrop and stack panels on it.
 */
export function AppShell({
  skipLinkLabel,
  navigationLabel,
  brand,
  navigation,
  aside,
  account,
  children,
}: AppShellProps) {
  return (
    <div className="min-h-screen bg-backdrop text-text">
      <a
        href="#main"
        className="sr-only z-50 rounded-sm bg-surface-inverse px-3 py-2 text-text-inverse focus:not-sr-only focus:fixed focus:top-4 focus:left-4"
      >
        {skipLinkLabel}
      </a>
      <header className="flex flex-wrap items-center gap-x-6 border-b border-border bg-canvas px-4 pt-3 sm:px-6 lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:w-60 lg:flex-col lg:flex-nowrap lg:items-stretch lg:border-r lg:border-b-0 lg:px-0 lg:pt-6">
        <div className="order-1 flex h-10 items-center lg:px-5">{brand}</div>
        <nav
          aria-label={navigationLabel}
          className="order-3 w-full py-3 lg:order-2 lg:mt-6 lg:px-4 lg:py-0"
        >
          <ul className="flex flex-wrap gap-x-2 gap-y-2 text-sm lg:flex-col lg:gap-1.5">
            {navigation.map((item, index) => (
              // Navigation items are static for the life of the shell, so the index is stable.
              <li key={index}>{item}</li>
            ))}
          </ul>
        </nav>
        {aside ? (
          <div className="hidden lg:order-3 lg:mt-auto lg:block lg:px-5 lg:pb-5">{aside}</div>
        ) : null}
        <div
          className={`order-2 ml-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm lg:order-4 lg:ml-0 lg:flex-col lg:items-start lg:gap-2 lg:border-t lg:border-border lg:px-5 lg:py-4 ${aside ? "" : "lg:mt-auto"}`}
        >
          {account}
        </div>
      </header>
      <main id="main" tabIndex={-1} className="focus:outline-none lg:pl-60">
        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-8 lg:py-10">{children}</div>
      </main>
    </div>
  );
}

/**
 * Classes for a navigation link. The current page is drawn as a selection, the logo's band
 * between two handles, and in bold, so it never relies on the band's tone.
 */
export const navLinkClasses =
  "flex h-9 items-center gap-2.5 rounded-xs px-2.5 text-text-muted no-underline transition-colors duration-150 hover:bg-surface-hover hover:text-text current:font-semibold current:selection-band current:hover:bg-selection";

export interface PageHeaderProps {
  title: string;
  /** A line under the title. */
  description?: ReactNode;
  /** Controls for the whole page, such as primary actions. */
  actions?: ReactNode;
  /** A link back to where the screen was opened from, shown above the title. */
  back?: ReactNode;
  /** Short facts beside the title, such as state and access badges. */
  meta?: ReactNode;
}

/** The single `h1` of a screen, with optional actions. */
export function PageHeader({ title, description, actions, back, meta }: PageHeaderProps) {
  return (
    <div className="mb-8">
      {back ? <div className="mb-4 text-sm">{back}</div> : null}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight break-words sm:text-3xl">{title}</h1>
          {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
          {description ? (
            <div className="mt-2 max-w-3xl text-sm text-text-muted">{description}</div>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/** Classes for the link back to the previous screen, above a page title. */
export const backLinkClasses =
  "inline-flex items-center gap-1.5 text-text-muted no-underline hover:text-text hover:underline";
