import { useLingui } from "@lingui/react";
import { createContext, useCallback, useContext } from "react";
import type { HumanCheckWidget } from "../human-check/turnstile.ts";
import type { DashboardApi } from "./api.ts";
import type { MessageId } from "./i18n/en.ts";
import type { ManifestBuilder } from "./publish/builder.ts";
import type { SavedFile } from "./publish/download.ts";
import type { StorageTransport } from "./publish/upload.ts";

/** What the dashboard needs from the outside world, so tests can provide fakes. */
export interface DashboardEnv {
  api: DashboardApi;
  /** Leaves the single-page app for another page of the host, such as the login page. */
  leave(url: string): void;
  /** Builds manifests off the main thread (a Web Worker in the browser). */
  manifests: ManifestBuilder;
  /** Uploads to and downloads from storage through presigned URLs. */
  storage: StorageTransport;
  /** Hands a file to the user, as a download. */
  save(file: SavedFile): void;
  /**
   * The human check widget (Turnstile) for a visitor's first comments; null when the page has no
   * site key, and absent in tests that never meet the check.
   */
  humanCheck?: HumanCheckWidget | null;
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

/** A UTC day (`YYYY-MM-DD`) as a short date in the dashboard's language, such as "8 Nov". */
export function useFormatDay(): (date: string, long?: boolean) => string {
  const { i18n } = useLingui();
  return useCallback(
    (date: string, long = false) =>
      i18n.date(
        new Date(`${date}T00:00:00Z`),
        long
          ? { dateStyle: "medium", timeZone: "UTC" }
          : { day: "numeric", month: "short", timeZone: "UTC" },
      ),
    [i18n],
  );
}

const RELATIVE_STEPS = [
  { unit: "minute", seconds: 60, below: 3600 },
  { unit: "hour", seconds: 3600, below: 86_400 },
  { unit: "day", seconds: 86_400, below: 7 * 86_400 },
] as const;

/**
 * Formats a past moment relative to now, for comments: "now", "5 minutes ago", "yesterday", and
 * the date itself once it is a week old or more.
 */
export function useRelativeTime(): (iso: string, now?: number) => string {
  const { i18n } = useLingui();
  return useCallback(
    (iso: string, now = Date.now()) => {
      const when = new Date(iso);
      const seconds = Math.max(0, Math.round((now - when.getTime()) / 1000));
      const format = new Intl.RelativeTimeFormat(i18n.locale, { numeric: "auto" });
      if (seconds < 60) return format.format(0, "second");
      for (const step of RELATIVE_STEPS) {
        if (seconds < step.below)
          return format.format(-Math.floor(seconds / step.seconds), step.unit);
      }
      return i18n.date(when, { dateStyle: "medium" });
    },
    [i18n],
  );
}

/** Formats a count for people, with the locale's grouping. */
export function useFormatNumber(): (value: number) => string {
  const { i18n } = useLingui();
  return useCallback((value: number) => i18n.number(value), [i18n]);
}

/** Formats a share of a whole (0 to 1) as a whole percentage, such as "42%". */
export function useFormatPercent(): (ratio: number) => string {
  const { i18n } = useLingui();
  return useCallback(
    (ratio: number) => i18n.number(ratio, { style: "percent", maximumFractionDigits: 0 }),
    [i18n],
  );
}

const BYTE_UNITS = [
  { unit: "gigabyte", size: 1e9 },
  { unit: "megabyte", size: 1e6 },
  { unit: "kilobyte", size: 1e3 },
] as const;

/** Formats a size in decimal units, like the product's limits: 1 MB is 1,000,000 bytes. */
export function useFormatBytes(): (bytes: number) => string {
  const { i18n } = useLingui();
  return useCallback(
    (bytes: number) => {
      const scale = BYTE_UNITS.find((entry) => bytes >= entry.size);
      return i18n.number(scale ? bytes / scale.size : bytes, {
        style: "unit",
        unit: scale ? scale.unit : "byte",
        // The short form of a byte is "byte" whatever the count, so plain bytes are spelled out.
        unitDisplay: scale ? "short" : "long",
        maximumFractionDigits: scale ? 1 : 0,
      });
    },
    [i18n],
  );
}
