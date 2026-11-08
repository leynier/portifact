import { AppShell, Button, LiveRegion, LoadingState, navLinkClasses } from "@portifact/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import wordmark from "../../../../../assets/brand/wordmark.svg";
import wordmarkDark from "../../../../../assets/brand/wordmark-dark.svg";
import { loginUrl } from "../../auth/query.ts";
import { AnnounceContext, useDashboard, useT } from "../context.tsx";

export const ACCOUNT_QUERY = ["account"] as const;

/** Frame of every dashboard screen: navigation, the signed-in account and announcements. */
export function Shell() {
  const t = useT();
  const { api, leave } = useDashboard();
  const location = useRouterState({ select: (state) => state.location });
  const here = `${location.pathname}${location.searchStr}`;

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
        <Link key="artifacts" to="/" activeOptions={{ exact: false }} className={navLinkClasses}>
          {t("shell.artifacts")}
        </Link>,
      ]}
      account={
        account.data ? (
          <>
            <span className="text-text-muted">
              {t("shell.account", { email: account.data.email })}
            </span>
            <Button
              intent="link"
              size="inline"
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
        {account.data ? <Outlet /> : <LoadingState label={t("shell.loadingAccount")} />}
      </AnnounceContext.Provider>
      <LiveRegion message={announcement} />
    </AppShell>
  );
}
