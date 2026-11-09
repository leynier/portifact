import { LogOut, Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Avatar } from "../components/avatar.tsx";
import { Drawer } from "../components/drawer.tsx";
import { IconButton } from "../components/icon-button.tsx";
import { ResizeHandle } from "../components/resize-handle.tsx";
import { Tooltip } from "../components/tooltip.tsx";

/** One item of the primary navigation. */
export interface AppShellNavItem {
  key: string;
  label: string;
  /** Decorative icon; it stays visible when the sidebar is collapsed to a rail. */
  icon: ReactNode;
  /**
   * Renders the link, such as a router link to the item's page, with the given class and
   * content. The link marks the current page with `aria-current="page"`.
   */
  render(props: { className: string; children: ReactNode }): ReactNode;
}

export interface AppShellLabels {
  skipLink: string;
  /** Accessible name of the primary navigation landmark. */
  navigation: string;
  /** The button that opens the navigation on narrow screens, and the drawer's name. */
  openNavigation: string;
  closeNavigation: string;
  collapseSidebar: string;
  expandSidebar: string;
  resizeSidebar: string;
}

export interface AppShellProps {
  labels: AppShellLabels;
  /** The logo, linking home. */
  brand: ReactNode;
  /** The symbol alone, linking home, for the collapsed sidebar. */
  compactBrand: ReactNode;
  navigation: AppShellNavItem[];
  /** The signed-in account and its controls, at the bottom of the sidebar (`SidebarAccount`). */
  account: ReactNode;
  /**
   * Key under which this browser remembers the collapsed state and width. Without storage the
   * shell starts expanded at the default width.
   */
  storageKey?: string;
  children: ReactNode;
}

export const SIDEBAR_WIDTH = { min: 208, max: 384, initial: 240 } as const;

interface SidebarState {
  collapsed: boolean;
  width: number;
}

const INITIAL: SidebarState = { collapsed: false, width: SIDEBAR_WIDTH.initial };

const clampWidth = (width: number) =>
  Math.round(Math.min(Math.max(width, SIDEBAR_WIDTH.min), SIDEBAR_WIDTH.max));

/** The remembered sidebar, or the initial one when storage is empty, invalid or unavailable. */
export function readSidebar(storageKey: string | undefined): SidebarState {
  if (!storageKey) return INITIAL;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return INITIAL;
    const parsed = JSON.parse(raw) as Partial<SidebarState> | null;
    return {
      collapsed: parsed?.collapsed === true,
      width:
        typeof parsed?.width === "number" && Number.isFinite(parsed.width)
          ? clampWidth(parsed.width)
          : INITIAL.width,
    };
  } catch {
    return INITIAL;
  }
}

function writeSidebar(storageKey: string | undefined, state: SidebarState) {
  if (!storageKey) return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Private windows and blocked storage: the sidebar still works, it is just not remembered.
  }
}

/** Where shell content is drawn: the sidebar (collapsed or not) or the drawer of small screens. */
const Placement = createContext<{ collapsed: boolean }>({ collapsed: false });

/** Classes for a navigation link, also when it is drawn as an icon in the collapsed rail. */
export const navLinkClasses =
  "flex h-9 w-full min-w-0 items-center gap-2.5 rounded-xs px-2.5 text-text-muted no-underline transition-colors duration-150 hover:bg-surface-hover hover:text-text current:font-semibold current:selection-band current:hover:bg-selection";

function NavList({ items }: { items: AppShellNavItem[] }) {
  const { collapsed } = useContext(Placement);
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {items.map((item) => (
        <li key={item.key}>
          <Tooltip label={item.label} side="right" disabled={!collapsed} block>
            {item.render({
              className: collapsed ? `${navLinkClasses} justify-center` : navLinkClasses,
              children: (
                <>
                  <span aria-hidden="true" className="inline-flex shrink-0">
                    {item.icon}
                  </span>
                  <span className={collapsed ? "sr-only" : "truncate"}>{item.label}</span>
                </>
              ),
            })}
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

/**
 * Page frame of the dashboard: a skip link, a banner and one main landmark that receives focus
 * from the skip link. From the `md` breakpoint the banner is a fixed sidebar with the primary
 * navigation and the account at the bottom; it collapses to an icon rail with tooltips and,
 * expanded, is resized by dragging its edge or with the arrow keys on it. Both are remembered
 * per browser. Below `md` the banner is a top bar whose menu button opens the navigation and the
 * account in a `Drawer`.
 */
export function AppShell({
  labels,
  brand,
  compactBrand,
  navigation,
  account,
  storageKey,
  children,
}: AppShellProps) {
  const root = useRef<HTMLDivElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const navId = useId();
  const drawerId = useId();
  const [state, setState] = useState<SidebarState>(INITIAL);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const loaded = useRef(false);

  // Read storage after mounting, so the first render is the same with and without it.
  useLayoutEffect(() => {
    setState(readSidebar(storageKey));
    loaded.current = true;
  }, [storageKey]);

  useEffect(() => {
    if (loaded.current) writeSidebar(storageKey, state);
  }, [storageKey, state]);

  // The width is geometry the person chose: set through the CSSOM, never a style attribute.
  useLayoutEffect(() => {
    root.current?.style.setProperty("--pf-sidebar-width", `${state.width}px`);
  }, [state.width]);

  const { collapsed } = state;
  const toggle = collapsed ? labels.expandSidebar : labels.collapseSidebar;

  return (
    <div ref={root} className="min-h-screen bg-backdrop text-text">
      <a
        href="#main"
        className="sr-only z-50 rounded-sm bg-surface-inverse px-3 py-2 text-text-inverse focus:not-sr-only focus:fixed focus:top-4 focus:left-4"
      >
        {labels.skipLink}
      </a>
      <header
        ref={sidebar}
        className={`sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-canvas px-4 md:fixed md:inset-y-0 md:left-0 md:h-auto md:flex-col md:items-stretch md:gap-0 md:border-r md:border-b-0 md:px-0 md:pt-4 ${collapsed ? "md:w-16" : "md:w-sidebar"}`}
      >
        <div
          className={`flex min-w-0 flex-1 items-center gap-2 md:flex-none ${collapsed ? "md:flex-col md:justify-center md:px-2" : "md:h-10 md:justify-between md:pr-3 md:pl-5"}`}
        >
          <div className={collapsed ? "md:hidden" : "min-w-0"}>{brand}</div>
          {collapsed ? <div className="hidden md:block">{compactBrand}</div> : null}
          <div className="ml-auto md:hidden">
            <IconButton
              label={labels.openNavigation}
              align="end"
              aria-expanded={drawerOpen}
              aria-controls={drawerId}
              icon={<Menu className="size-5" />}
              onClick={() => setDrawerOpen(true)}
            />
          </div>
          <div className={`hidden md:block ${collapsed ? "md:mt-3" : ""}`}>
            <IconButton
              label={toggle}
              side="right"
              aria-expanded={!collapsed}
              aria-controls={navId}
              icon={
                collapsed ? (
                  <PanelLeftOpen className="size-4" />
                ) : (
                  <PanelLeftClose className="size-4" />
                )
              }
              onClick={() => setState((current) => ({ ...current, collapsed: !collapsed }))}
            />
          </div>
        </div>
        <Placement.Provider value={{ collapsed }}>
          <nav
            id={navId}
            aria-label={labels.navigation}
            className={`hidden md:mt-6 md:block ${collapsed ? "md:px-3" : "md:px-4"}`}
          >
            <NavList items={navigation} />
          </nav>
          <div
            className={`hidden border-t border-border md:mt-auto md:block md:py-3 ${collapsed ? "md:px-2" : "md:px-3"}`}
          >
            {account}
          </div>
        </Placement.Provider>
        {collapsed ? null : (
          <div className="hidden md:block">
            <ResizeHandle
              label={labels.resizeSidebar}
              value={state.width}
              min={SIDEBAR_WIDTH.min}
              max={SIDEBAR_WIDTH.max}
              fromPointer={(clientX) =>
                clientX - (sidebar.current?.getBoundingClientRect().left ?? 0)
              }
              onChange={(width) => setState((current) => ({ ...current, width }))}
            />
          </div>
        )}
      </header>
      <Drawer
        id={drawerId}
        open={drawerOpen}
        label={labels.openNavigation}
        closeLabel={labels.closeNavigation}
        onClose={() => setDrawerOpen(false)}
        header={brand}
      >
        <Placement.Provider value={{ collapsed: false }}>
          <nav aria-label={labels.navigation} className="px-3 py-4">
            <NavList items={navigation} />
          </nav>
          <div className="mt-auto border-t border-border px-3 py-3">{account}</div>
        </Placement.Provider>
      </Drawer>
      <main
        id="main"
        tabIndex={-1}
        className={`focus:outline-none ${collapsed ? "md:pl-16" : "md:pl-sidebar"}`}
      >
        {/* Aligned to the sidebar and capped by `max-w-page`, so wide screens do not leave a column
            floating between two empty gutters. */}
        <div className="w-full max-w-page px-4 py-8 sm:px-8 lg:px-10 lg:py-10">{children}</div>
      </main>
    </div>
  );
}

export interface SidebarAccountProps {
  name: string;
  email: string;
  image?: string | null | undefined;
  /** Names the link to the profile, such as "Profile". */
  profileLabel: string;
  /**
   * Renders the link to the profile with the given class and content, and the accessible name
   * when the content has no visible text (the collapsed rail).
   */
  renderProfileLink(props: {
    className: string;
    children: ReactNode;
    "aria-label"?: string;
  }): ReactNode;
  signOutLabel: string;
  signingOut?: boolean;
  onSignOut(): void;
}

/**
 * The signed-in account at the bottom of the sidebar and the drawer: avatar, name and email
 * (truncated, linking to the profile) and a sign-out icon button. In the collapsed rail only the
 * avatar and the button remain, with tooltips.
 */
export function SidebarAccount({
  name,
  email,
  image,
  profileLabel,
  renderProfileLink,
  signOutLabel,
  signingOut = false,
  onSignOut,
}: SidebarAccountProps) {
  const { collapsed } = useContext(Placement);
  const shown = name.trim() || email.split("@")[0] || email;
  const signOut = (
    <IconButton
      label={signOutLabel}
      side={collapsed ? "right" : "top"}
      align={collapsed ? "center" : "end"}
      busy={signingOut}
      icon={<LogOut className="size-4" />}
      onClick={onSignOut}
    />
  );
  const profileName = `${profileLabel}: ${shown} ${email}`;
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2">
        <Tooltip label={profileLabel} side="right">
          {renderProfileLink({
            className:
              "inline-flex rounded-full no-underline transition-opacity duration-150 hover:opacity-85",
            "aria-label": profileName,
            children: (
              <Avatar name={name} email={email} image={image} size="md" tone="solid" letters={2} />
            ),
          })}
        </Tooltip>
        {signOut}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {renderProfileLink({
        className:
          "flex min-w-0 flex-1 items-center gap-2.5 rounded-xs p-1.5 text-text no-underline transition-colors duration-150 hover:bg-surface-hover current:bg-surface-hover",
        // The visible name and email name the link, so speech input can use what is on screen.
        children: (
          <>
            <Avatar name={name} email={email} image={image} size="md" tone="solid" letters={2} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">
                <span className="sr-only">{profileLabel}: </span>
                {shown}
              </span>{" "}
              <span className="truncate text-xs text-text-muted">{email}</span>
            </span>
          </>
        ),
      })}
      {signOut}
    </div>
  );
}

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
