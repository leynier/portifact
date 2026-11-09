import {
  AppShell,
  type AppShellNavItem,
  Callout,
  LoadingState,
  SidebarAccount,
  ThemedImage,
  ThemeSwitcher,
  Toast,
  useSidebarCollapsed,
} from "@portifact/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Cable, Gauge, Layers, Settings, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import symbol from "../../../../../assets/brand/symbol.svg";
import symbolDark from "../../../../../assets/brand/symbol-dark.svg";
import wordmark from "../../../../../assets/brand/wordmark.svg";
import wordmarkDark from "../../../../../assets/brand/wordmark-dark.svg";
import { loginUrl } from "../../auth/query.ts";
import { AnnounceContext, useDashboard, useT } from "../context.tsx";
import { LanguageChoice, useAccountLocale } from "./language.tsx";
import { useUsage } from "./usage.tsx";

export const ACCOUNT_QUERY = ["account"] as const;
/** Where this browser remembers whether the sidebar is collapsed and how wide it is. */
export const SIDEBAR_STORAGE_KEY = "portifact.dashboard.sidebar";
/** The names of the theme choices, for every theme switcher of the dashboard. */
export function themeLabels(t: ReturnType<typeof useT>) {
  return { system: t("theme.system"), light: t("theme.light"), dark: t("theme.dark") };
}

/** The quick theme switch above the account: icons only, stacked in the collapsed rail. */
function QuickTheme() {
  const t = useT();
  const collapsed = useSidebarCollapsed();
  return (
    <div className={collapsed ? "flex justify-center" : ""}>
      <ThemeSwitcher
        legend={t("theme.legend")}
        labels={themeLabels(t)}
        compact
        orientation={collapsed ? "vertical" : "horizontal"}
      />
    </div>
  );
}

/**
 * The visible notice while the platform's budget protection limits publishing (plan section 12).
 * It comes from the account's usage blocks, so the API, the CLI and MCP report the same thing.
 */
function CapacityNotice() {
  const t = useT();
  const block = useUsage().data?.blocks.find((b) => b.reason === "capacity");
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

/**
 * Frame of every dashboard screen: the navigation (Artifacts, Publish, Apps, Usage, Settings),
 * the signed-in account with its link to the profile and sign out, and announcements.
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

  const navigation: AppShellNavItem[] = [
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
    {
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
    {
      key: "usage",
      label: t("shell.usageLink"),
      icon: <Gauge className="size-4" />,
      render: (props) => <Link to="/usage" {...props} />,
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
      navigation={navigation}
      account={
        <div className="flex flex-col gap-3">
          <QuickTheme />
          {account.data ? (
            <SidebarAccount
              name={account.data.name}
              email={account.data.email}
              profileLabel={t("shell.profileLink")}
              renderProfileLink={(props) => <Link to="/profile" {...props} />}
              signOutLabel={t("shell.signOut")}
              signingOut={signOut.isPending}
              onSignOut={() => signOut.mutate()}
              extra={<LanguageChoice variant="compact" />}
            />
          ) : (
            <span className="text-sm text-text-muted">{t("shell.loadingAccount")}</span>
          )}
        </div>
      }
    >
      <AnnounceContext.Provider value={announce}>
        {account.data ? (
          <>
            <CapacityNotice />
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
