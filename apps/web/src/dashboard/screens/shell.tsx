import type { RoleAction } from "@portifact/contracts";
import {
  AppShell,
  type AppShellNavItem,
  Callout,
  LoadingState,
  PageHeader,
  SidebarAccount,
  SpaceSwitcher,
  type SpaceSwitcherOption,
  ThemedImage,
  ThemeSwitcher,
  Toast,
  useSidebarCollapsed,
} from "@portifact/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  BadgeCheck,
  Cable,
  Gauge,
  KeySquare,
  Layers,
  Mail,
  Palette,
  ScrollText,
  Settings,
  Upload,
  Users,
  UsersRound,
  Webhook,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import symbol from "../../../../../assets/brand/symbol.svg";
import symbolDark from "../../../../../assets/brand/symbol-dark.svg";
import wordmark from "../../../../../assets/brand/wordmark.svg";
import wordmarkDark from "../../../../../assets/brand/wordmark-dark.svg";
import { loginUrl } from "../../auth/query.ts";
import { AnnounceContext, useDashboard, useT } from "../context.tsx";
import { ROLE_LABELS, type Space, spaceCan, useSpace } from "../space.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { INCOMING_QUERY, useIncomingInvitations } from "./invitations.tsx";
import { LanguageChoice, useAccountLocale } from "./language.tsx";
import { useUsage } from "./usage.tsx";

export { INCOMING_QUERY };

export const ACCOUNT_QUERY = ["account"] as const;
/** Where this browser remembers whether the sidebar is collapsed and how wide it is. */
export const SIDEBAR_STORAGE_KEY = "portifact.dashboard.sidebar";
/** The names of the theme choices, for every theme switcher of the dashboard. */
export function themeLabels(t: ReturnType<typeof useT>) {
  return { system: t("theme.system"), light: t("theme.light"), dark: t("theme.dark") };
}

/**
 * The quick preferences above the account: the theme switch (icons only) and the language in one
 * row. The collapsed rail keeps only the theme, stacked; the language stays on the settings page.
 */
function QuickPreferences() {
  const t = useT();
  const collapsed = useSidebarCollapsed();
  const theme = (
    <ThemeSwitcher
      legend={t("theme.legend")}
      labels={themeLabels(t)}
      compact
      orientation={collapsed ? "vertical" : "horizontal"}
    />
  );
  if (collapsed) return <div className="flex justify-center">{theme}</div>;
  return (
    <div className="flex items-center gap-2">
      <div className="shrink-0">{theme}</div>
      <div className="flex min-w-0 flex-1 justify-end">
        <LanguageChoice variant="sidebar" />
      </div>
    </div>
  );
}

/**
 * The visible notice while the platform's budget protection limits publishing (plan section 12).
 * It comes from the account's usage blocks, so the API, the CLI and MCP report the same thing.
 */
function CapacityNotice({ space }: { space: Space }) {
  const t = useT();
  const usage = useUsage(space.slug, spaceCan(space, "usage"));
  const block = usage.data?.blocks.find((b) => b.reason === "capacity");
  if (!block) return null;
  return (
    <div className="mb-6">
      <Callout title={t("shell.capacity.title")} icon={<Gauge className="size-5" />}>
        {t(
          block.stops === "new_artifacts"
            ? "shell.capacity.new_artifacts"
            : "shell.capacity.publishing",
        )}
      </Callout>
    </div>
  );
}

/** The invitations waiting for the signed-in account, as a notice on every screen but their own. */
function InvitationsNotice() {
  const t = useT();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const count = useIncomingInvitations().data?.items.length ?? 0;
  if (count === 0 || pathname === "/invitations") return null;
  return (
    <div className="mb-6">
      <Callout
        title={t("invitations.notice.title")}
        icon={<Mail className="size-5" />}
        action={
          <Link to="/invitations" className="font-semibold">
            {t("invitations.notice.link")}
          </Link>
        }
      >
        {t("invitations.notice.body", { count })}
      </Callout>
    </div>
  );
}

/** The screen of a space the URL names but the user is not in: exactly like a missing page. */
function MissingSpace() {
  const t = useT();
  useDocumentTitle(t("space.missing.title"));
  return (
    <>
      <PageHeader title={t("space.missing.title")} />
      <p className="mb-6 max-w-3xl text-text-muted">{t("space.missing.body")}</p>
      <Link to="/" search={{ workspace: undefined }} className="font-semibold">
        {t("space.missing.personal")}
      </Link>
    </>
  );
}

/** Pages that show one space: switching keeps the page, everything else goes to the list. */
const SPACE_PAGES = new Set([
  "/",
  "/publish",
  "/usage",
  "/plan",
  "/branding",
  "/members",
  "/groups",
  "/audit",
  "/service-tokens",
]);

/** The space menu above the navigation: Personal and each workspace, with the role there. */
function SpaceMenu({ state }: { state: ReturnType<typeof useSpace> }) {
  const t = useT();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const invitations = useIncomingInvitations().data?.items.length ?? 0;
  if (state.status !== "ready") return null;
  const { space, workspaces } = state;
  const target = SPACE_PAGES.has(pathname) ? pathname : "/";
  const to = (slug: string | undefined) =>
    (slug === undefined &&
    (target === "/members" || target === "/groups" || target === "/service-tokens")
      ? "/"
      : target) as "/";
  const personal = { name: t("space.personal"), detail: t("space.personalDetail") };
  const current =
    space.kind === "personal" ? personal : { name: space.name, detail: t(ROLE_LABELS[space.role]) };
  return (
    <SpaceSwitcher
      label={t("space.label")}
      current={current}
      options={[
        {
          key: "personal",
          ...personal,
          current: space.kind === "personal",
          render: ({ children, ...props }) => (
            <Link to={to(undefined)} search={{ workspace: undefined }} {...props}>
              {children}
            </Link>
          ),
        },
        ...workspaces.map((workspace) => ({
          key: workspace.slug,
          name: workspace.name,
          detail: t(ROLE_LABELS[workspace.role]),
          current: space.slug === workspace.slug,
          render: ({ children, ...props }: Parameters<SpaceSwitcherOption["render"]>[0]) => (
            <Link to={to(workspace.slug)} search={{ workspace: workspace.slug }} {...props}>
              {children}
            </Link>
          ),
        })),
      ]}
      footer={
        invitations > 0 ? (
          <Link to="/invitations" search={{ workspace: undefined }} className="text-sm">
            {t("space.invitations", { count: invitations })}
          </Link>
        ) : undefined
      }
    />
  );
}

/**
 * Frame of every dashboard screen/**
 * Frame of every dashboard screen: the space menu, the navigation (Artifacts, Publish, Apps,
 * Usage, Plan, Branding, Members and Service tokens in a workspace, Settings, each only where the
 * role in the space allows it), the signed-in account with its link to the profile and sign out,
 * and announcements.
 */
export function Shell() {
  const t = useT();
  const { api, leave } = useDashboard();
  const location = useRouterState({ select: (state) => state.location });
  const here = `${location.pathname}${location.searchStr}`;
  const onArtifactPage = /^\/(artifacts|review)\//.test(location.pathname);

  const account = useQuery({ queryKey: ACCOUNT_QUERY, queryFn: () => api.account() });
  useAccountLocale();
  useEffect(() => {
    if (account.data === null) leave(loginUrl(here));
  }, [account.data, here, leave]);

  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((message: string) => setAnnouncement(message), []);

  const signOut = useMutation({
    mutationFn: () => api.signOut(),
    onMutate: () => announce(t("shell.signingOut")),
    onSuccess: () => leave("/login"),
    onError: () => announce(t("shell.signOutFailed")),
  });

  // After a client-side navigation, move focus to the new screen like a page load would.
  const previousPath = useRef(location.pathname);
  useEffect(() => {
    if (previousPath.current === location.pathname) return;
    previousPath.current = location.pathname;
    document.getElementById("main")?.focus();
  }, [location.pathname]);

  const spaceState = useSpace();
  const space = spaceState.status === "ready" ? spaceState.space : null;
  // Pages a role cannot use are left out of the navigation; the pages say so if opened anyway.
  const allowed = (action: RoleAction) => space !== null && spaceCan(space, action);
  const navigation: (AppShellNavItem | false)[] = [
    {
      key: "artifacts",
      label: t("shell.artifacts"),
      icon: <Layers className="size-4" />,
      render: (props) => (
        <Link
          to="/"
          activeOptions={{ exact: true }}
          // Artifact pages and their review belong to this section too.
          {...(onArtifactPage ? { "aria-current": "page" as const } : {})}
          {...props}
        />
      ),
    },
    allowed("publish") && {
      key: "publish",
      label: t("shell.publishLink"),
      icon: <Upload className="size-4" />,
      render: (props) => <Link to="/publish" {...props} />,
    },
    {
      key: "apps",
      label: t("shell.appsLink"),
      icon: <Cable className="size-4" />,
      render: (props) => <Link to="/apps" {...props} />,
    },
    allowed("usage") && {
      key: "usage",
      label: t("shell.usageLink"),
      icon: <Gauge className="size-4" />,
      render: (props) => <Link to="/usage" {...props} />,
    },
    {
      key: "plan",
      label: t("shell.planLink"),
      icon: <BadgeCheck className="size-4" />,
      render: (props) => <Link to="/plan" {...props} />,
    },
    allowed("webhooks") && {
      key: "webhooks",
      label: t("shell.webhooksLink"),
      icon: <Webhook className="size-4" />,
      render: (props) => <Link to="/webhooks" {...props} />,
    },
    allowed("brand") && {
      key: "branding",
      label: t("shell.brandingLink"),
      icon: <Palette className="size-4" />,
      render: (props) => <Link to="/branding" {...props} />,
    },
    space?.kind === "workspace" && {
      key: "members",
      label: t("shell.membersLink"),
      icon: <Users className="size-4" />,
      render: (props) => <Link to="/members" {...props} />,
    },
    space?.kind === "workspace" &&
      allowed("members") && {
        key: "groups",
        label: t("shell.groupsLink"),
        icon: <UsersRound className="size-4" />,
        render: (props) => <Link to="/groups" {...props} />,
      },
    allowed("audit") && {
      key: "audit",
      label: t("shell.auditLink"),
      icon: <ScrollText className="size-4" />,
      render: (props) => <Link to="/audit" {...props} />,
    },
    space?.kind === "workspace" &&
      allowed("tokens") && {
        key: "service-tokens",
        label: t("shell.serviceTokensLink"),
        icon: <KeySquare className="size-4" />,
        render: (props) => <Link to="/service-tokens" {...props} />,
      },
    {
      key: "settings",
      label: t("shell.settingsLink"),
      icon: <Settings className="size-4" />,
      render: (props) => <Link to="/settings" {...props} />,
    },
  ];

  return (
    <AppShell
      labels={{
        skipLink: t("shell.skipLink"),
        navigation: t("shell.navigation"),
        openNavigation: t("shell.openNavigation"),
        closeNavigation: t("shell.closeNavigation"),
        collapseSidebar: t("shell.collapseSidebar"),
        expandSidebar: t("shell.expandSidebar"),
        resizeSidebar: t("shell.resizeSidebar"),
      }}
      storageKey={SIDEBAR_STORAGE_KEY}
      brand={
        <Link to="/" aria-label={t("shell.home")} className="no-underline">
          <ThemedImage
            src={wordmark}
            darkSrc={wordmarkDark}
            alt=""
            width={148}
            height={40}
            className="h-7 w-auto"
          />
        </Link>
      }
      compactBrand={
        <Link to="/" aria-label={t("shell.home")} className="no-underline">
          <ThemedImage
            src={symbol}
            darkSrc={symbolDark}
            alt=""
            width={32}
            height={32}
            className="size-8"
          />
        </Link>
      }
      navigation={navigation.filter((item): item is AppShellNavItem => item !== false)}
      switcher={<SpaceMenu state={spaceState} />}
      account={
        <div className="flex flex-col gap-3">
          <QuickPreferences />
          {account.data ? (
            <SidebarAccount
              name={account.data.name}
              email={account.data.email}
              profileLabel={t("shell.profileLink")}
              renderProfileLink={(props) => <Link to="/profile" {...props} />}
              signOutLabel={t("shell.signOut")}
              signingOut={signOut.isPending}
              onSignOut={() => signOut.mutate()}
            />
          ) : (
            <span className="text-sm text-text-muted">{t("shell.loadingAccount")}</span>
          )}
        </div>
      }
    >
      <AnnounceContext.Provider value={announce}>
        {account.data && spaceState.status === "missing" ? (
          <MissingSpace />
        ) : account.data && space ? (
          <>
            <InvitationsNotice />
            <CapacityNotice space={space} />
            <Outlet />
          </>
        ) : (
          <LoadingState label={t("shell.loadingAccount")} skeleton={4} />
        )}
      </AnnounceContext.Provider>
      <Toast message={announcement} dismissLabel={t("shell.dismiss")} />
    </AppShell>
  );
}
