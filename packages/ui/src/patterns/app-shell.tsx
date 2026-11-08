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
  /** The signed-in account and its controls, such as sign out. */
  account: ReactNode;
  children: ReactNode;
}

/**
 * Page frame of the dashboard: a skip link, a header with the brand, the primary navigation
 * and the account, and one main landmark that receives focus from the skip link.
 */
export function AppShell({
  skipLinkLabel,
  navigationLabel,
  brand,
  navigation,
  account,
  children,
}: AppShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-text">
      <a
        href="#main"
        className="sr-only z-50 rounded-sm bg-surface-inverse px-3 py-2 text-text-inverse focus:not-sr-only focus:fixed focus:top-4 focus:left-4"
      >
        {skipLinkLabel}
      </a>
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3">
          <div className="flex h-10 items-center">{brand}</div>
          <nav aria-label={navigationLabel} className="flex-1">
            <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              {navigation.map((item, index) => (
                // Navigation items are static for the life of the shell, so the index is stable.
                <li key={index}>{item}</li>
              ))}
            </ul>
          </nav>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">{account}</div>
        </div>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 focus:outline-none"
      >
        {children}
      </main>
    </div>
  );
}

/** Classes for a navigation link; the current page is marked by weight and an underline. */
export const navLinkClasses =
  "text-text-muted no-underline hover:text-text current:font-semibold current:text-text current:underline";

export interface PageHeaderProps {
  title: string;
  /** A line under the title. */
  description?: ReactNode;
  /** Controls for the whole page, such as primary actions. */
  actions?: ReactNode;
}

/** The single `h1` of a screen, with optional actions. */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight break-words">{title}</h1>
        {description ? <div className="mt-1 text-sm text-text-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
    </div>
  );
}
