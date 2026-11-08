// Dashboard refresh policy (plan section 2): at most every 30 seconds while the tab is visible,
// paused in the background, with a growing wait after errors.

export const REFRESH_INTERVAL_MS = 30_000;
export const MAX_REFRESH_INTERVAL_MS = 5 * 60_000;

/** Milliseconds until the next refresh after `failures` consecutive failed refreshes. */
export function refreshInterval(failures: number): number {
  const wait = REFRESH_INTERVAL_MS * 2 ** Math.max(0, failures);
  return Math.min(wait, MAX_REFRESH_INTERVAL_MS);
}

/** Query options that apply the policy. TanStack Query pauses intervals in hidden tabs. */
export const refreshOptions = {
  staleTime: REFRESH_INTERVAL_MS,
  refetchIntervalInBackground: false,
  refetchInterval: (query: { state: { fetchFailureCount: number } }) =>
    refreshInterval(query.state.fetchFailureCount),
} as const;
