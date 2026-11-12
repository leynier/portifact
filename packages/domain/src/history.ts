// How long the records that outlive what they describe are kept (docs/operations.md, "History
// retention"). Pure rules; the scans that apply them are in packages/services.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lifecycle and moderation records of an artifact that was purged, or of an account that was
 * deleted, are kept this long after it went, then deleted. A year covers the six months in which
 * a person can complain about a moderation decision, the time an appeal or an out-of-court
 * settlement takes after that, and the reports that show the same abuse coming back; after it the
 * `artifact` and `account` tombstones still keep every ID from being reused.
 */
export const HISTORY_RETENTION_DAYS = 365;

/** Usage events are only counted in 24-hour windows; kept a week for support questions. */
export const USAGE_EVENT_RETENTION_DAYS = 7;

/**
 * Closed upload sessions (committed, failed, aborted or expired) are kept this long after they
 * expired, long past any retry of their commit, and only once nothing depends on them any more.
 */
export const CLOSED_UPLOAD_RETENTION_DAYS = 30;

/**
 * A storage finding the reconciliation has not seen again for this long is stale (its pass would
 * have cleared or refreshed it); deleting it loses nothing, because a pass that still sees the
 * problem records it again.
 */
export const STALE_FINDING_DAYS = 90;

/** Records about something gone before this moment are past their retention. */
export function historyCutoff(now: number): number {
  return now - HISTORY_RETENTION_DAYS * DAY_MS;
}

/** The moment before which a record kept `days` days is past its retention. */
export function daysBefore(now: number, days: number): number {
  return now - days * DAY_MS;
}

/**
 * The value an account's ID is replaced with in the records that stay with an artifact after the
 * account is deleted (comment actions, "message deleted" markers, threads others replied to): it
 * names no account, so those records keep their place without saying whose they were.
 */
export const ERASED_ACCOUNT = "deleted";

/**
 * Expired sign-in records (browser sessions, sign-in code records, OAuth tokens, device codes and
 * client assertions) are deleted this long after they expired: nothing reads an expired record,
 * and a day keeps clear of clock skew and of a refresh racing its own expiry.
 */
export const EXPIRED_AUTH_GRACE_MS = DAY_MS;

/**
 * An app registered without an account (dynamic client registration, MCP) and never authorized
 * by anyone (no consent, no token) is deleted this long after it registered. An MCP client
 * registers when it first connects and gets a consent as soon as a person approves it; one that
 * comes back with a deleted client ID is told the client is unknown and registers again.
 */
export const UNUSED_APP_REGISTRATION_DAYS = 30;
