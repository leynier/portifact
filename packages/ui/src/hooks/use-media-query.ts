import { useSyncExternalStore } from "react";

/** Tailwind's `sm` breakpoint: at least this wide is no longer a phone layout. */
export const WIDE_QUERY = "(min-width: 40rem)";

/**
 * Whether a media query matches, following changes. For layouts that need different markup on
 * narrow screens, not only different styles, such as filters behind a button in a sheet; render
 * one or the other, never both, so assistive technology never meets the same controls twice.
 * Without `matchMedia`, it answers `fallback`.
 */
export function useMediaQuery(query: string, fallback = true): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}
