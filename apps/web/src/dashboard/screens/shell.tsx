import { AppShell, Button, Callout, LoadingState, navLinkClasses, Toast } from "@portifact/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { CircleUserRound, Gauge, Layers, LogOut, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import wordmark from "../../../../../assets/brand/wordmark.svg";
import wordmarkDark from "../../../../../assets/brand/wordmark-dark.svg";
import { loginUrl } from "../../auth/query.ts";
import { AnnounceContext, useDashboard, useT } from "../context.tsx";
import { useUsage } from "./usage.tsx";

export const ACCOUNT_QUERY = ["account"] as const;
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

/** Frame of every dashboard screen: navigation, the signed-in account and announcements. */
export function Shell() {
  const t = useT();
  const { api, leave } = useDashboard();
  const location = useRouterState({ select: (state) => state.location });
  const here = `${location.pathname}${location.searchStr}`;
  const onArtifactPage = /^\/(artifacts|review)\//.test(location.pathname);

  const account = useQuery({ queryKey: ACCOUNT_QUERY, queryFn: () => api.account() });
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

  return (
    <AppShell
      skipLinkLabel={t("shell.skipLink")}
      navigationLabel={t("shell.navigation")}
      brand={
        <Link to="/" aria-label={t("shell.home")} className="no-underline">
          <picture>
            <source media="(prefers-color-scheme: dark)" srcSet={wordmarkDark} />
            <img src={wordmark} alt="" width={148} height={40} className="h-7 w-auto" />
          </picture>
        </Link>
      }
      navigation={[
        <Link
          key="artifacts"
          to="/"
          activeOptions={{ exact: true }}
          // Artifact pages and their review belong to this section too.
          {...(onArtifactPage ? { "aria-current": "page" as const } : {})}
          className={navLinkClasses}
        >
          <Layers aria-hidden="true" className="size-4 shrink-0" />
          {t("shell.artifacts")}
        </Link>,
        <Link key="publish" to="/publish" className={navLinkClasses}>
          <Upload aria-hidden="true" className="size-4 shrink-0" />
          {t("shell.publishLink")}
        </Link>,
        <Link key="account" to="/account" className={navLinkClasses}>
          <CircleUserRound aria-hidden="true" className="size-4 shrink-0" />
          {t("shell.accountLink")}
        </Link>,
      ]}
      account={
        account.data ? (
          <>
            <span className="sr-only text-text-muted lg:not-sr-only lg:max-w-full lg:truncate">
              {t("shell.account", { email: account.data.email })}
            </span>
            <Button
              intent="ghost"
              size="sm"
              icon={<LogOut className="size-4" />}
              busy={signOut.isPending}
              onClick={() => signOut.mutate()}
            >
              {t("shell.signOut")}
            </Button>
          </>
        ) : (
          <span className="text-text-muted">{t("shell.loadingAccount")}</span>
        )
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
