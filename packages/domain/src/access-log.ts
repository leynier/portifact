// Access log rules (plan sections 2, 11 and 13): which openings are recorded, the 30-minute
// window that deduplicates them and the 30 days they are kept. Only signed-in visitors are ever
// identified; anonymous visits of public artifacts are not recorded.
import { ACCESS_LOG } from "@portifact/contracts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const ACCESS_WINDOW_MS = ACCESS_LOG.windowMinutes * MINUTE_MS;
export const ACCESS_RETENTION_MS = ACCESS_LOG.retentionDays * DAY_MS;

/** Start of the deduplication window that contains `at`; one entry per visitor and window. */
export function accessWindow(at: number): number {
  return Math.floor(at / ACCESS_WINDOW_MS) * ACCESS_WINDOW_MS;
}

/** Openings before this instant are past retention and are deleted. */
export function accessLogCutoff(now: number): number {
  return now - ACCESS_RETENTION_MS;
}

/** What delivery knows about a request it is about to serve. */
export interface ServedRequest {
  /** A page load (`Sec-Fetch-Mode: navigate`), top-level or in a frame; not a subresource. */
  navigation: boolean;
  /** The signed-in visitor a read or review session names; null for an anonymous visit. */
  visitorId: string | null;
  ownerId: string;
}

/**
 * An opening is a page load by a signed-in visitor who is not the owner. Subresources (each
 * asset) and anonymous visits are never recorded, and the owner's own visits are not openings.
 */
export function isLoggedOpening(request: ServedRequest): boolean {
  return request.navigation && request.visitorId !== null && request.visitorId !== request.ownerId;
}
