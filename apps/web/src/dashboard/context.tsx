import { useLingui } from "@lingui/react";
import { createContext, useCallback, useContext } from "react";
import type { DashboardApi } from "./api.ts";
import type { MessageId } from "./i18n/en.ts";

/** What the dashboard needs from the outside world, so tests can provide fakes. */
export interface DashboardEnv {
  api: DashboardApi;
  /** Leaves the single-page app for another page of the host, such as the login page. */
  leave(url: string): void;
}

export const DashboardContext = createContext<DashboardEnv | null>(null);

export function useDashboard(): DashboardEnv {
  const env = useContext(DashboardContext);
  if (!env) throw new Error("useDashboard needs a DashboardContext provider");
  return env;
}

/** Posts a polite announcement, such as the result of an action, from any screen. */
export const AnnounceContext = createContext<(message: string) => void>(() => {});

export function useAnnounce(): (message: string) => void {
  return useContext(AnnounceContext);
}

type Values = Record<string, string | number>;

/** Translates a message of the dashboard catalog. */
export function useT(): (id: MessageId, values?: Values) => string {
  const { i18n } = useLingui();
  return useCallback((id: MessageId, values?: Values) => i18n._(id, values), [i18n]);
}

/** Formats an ISO date for people: a date, or a date and time. */
export function useFormatDate(): (iso: string, withTime?: boolean) => string {
  const { i18n } = useLingui();
  return useCallback(
    (iso: string, withTime = false) =>
      i18n.date(
        new Date(iso),
        withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" },
      ),
    [i18n],
  );
}
