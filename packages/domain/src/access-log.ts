// Access log rules (plan sections 2, 11 and 13): which openings are recorded, the 30-minute
// window that deduplicates them and how long they are kept (30 days on free, the owner's
// `accessLogRetentionDays` otherwise). Only signed-in visitors are ever
// identified, and only on `restricted` artifacts; public, `authenticated`, `workspace` and `domain`
// ones are never recorded.
import { ACCESS_LOG, type AccessMode } from "@portifact/contracts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const ACCESS_WINDOW_MS = ACCESS_LOG.windowMinutes * MINUTE_MS;
export const ACCESS_RETENTION_MS = ACCESS_LOG.retentionDays * DAY_MS;

/** Start of the deduplication window that contains `at`; one entry per visitor and window. */
export function accessWindow(at: number): number {
  return Math.floor(at / ACCESS_WINDOW_MS) * ACCESS_WINDOW_MS;
}

/**
 * Openings before this instant are past retention: the free 30 days, or the owner's
 * `accessLogRetentionDays` when given.
 */
export function accessLogCutoff(now: number, retentionDays?: number): number {
  return retentionDays === undefined ? now - ACCESS_RETENTION_MS : now - retentionDays * DAY_MS;
}

/** What delivery knows about a request it is about to serve. */
export interface ServedRequest {
  /** A page load (`Sec-Fetch-Mode: navigate`), top-level or in a frame; not a subresource. */
  navigation: boolean;
  /** The signed-in visitor a read or review session names; null for an anonymous visit. */
  visitorId: string | null;
  ownerId: string;
  /**
   * The artifact's access mode. Only `restricted` artifacts are logged: their readers are the
   * addresses the owner listed. Public and `authenticated` artifacts open for anyone signed in
   * (in the viewer, or through the read handoff without a click), so any site could send a
   * visitor there and hand the owner their email; `workspace` and `domain` artifacts open the
   * same way for a whole workspace or email domain the owner never listed person by person
   * (decision 0010).
   */
  accessMode: AccessMode;
}

/**
 * An opening is a page load of a `restricted` artifact by a signed-in visitor who is not the
 * owner. Subresources (each asset), anonymous visits, every visit of a public, `authenticated`,
 * `workspace` or `domain` artifact and the owner's own visits are never recorded.
 */
export function isLoggedOpening(request: ServedRequest): boolean {
  return (
    request.navigation &&
    request.accessMode === "restricted" &&
    request.visitorId !== null &&
    request.visitorId !== request.ownerId
  );
}

/**
 * A page load through a share link (decision 0008) of any artifact that is not public is recorded for the link, never for a person: the link names no one, so recording it
 * hands the owner no identity. Public artifacts are never recorded, as above.
 */
export function isLoggedLinkOpening(request: {
  navigation: boolean;
  accessMode: ServedRequest["accessMode"];
}): boolean {
  return request.navigation && request.accessMode !== "public";
}
