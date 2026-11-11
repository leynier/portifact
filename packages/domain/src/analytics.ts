// Analytics per artifact (premium plan P8, decision 0007): what a page view is, how long view
// counters and access log rows are kept on the owner's plan, and the range one read returns.
// Pure rules: the content Worker decides a view from what it already knows about the request and
// its answer, and the services apply the retention and the range.
import { ANALYTICS, PLANS } from "@portifact/contracts";
import { type Entitlements, PLAN_GRACE_MS } from "./plans.ts";
import { fail, ok, type Result } from "./result.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the UTC day that contains `at`. */
export function utcDay(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

/** A UTC day as `YYYY-MM-DD`. */
export function formatDay(day: number): string {
  return new Date(day).toISOString().slice(0, 10);
}

/** The first instant of a `YYYY-MM-DD` UTC day (validated by `StatsDate` at the boundary). */
export function parseDay(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/**
 * What delivery knows about a request it answered for an artifact, after authorization, the
 * traffic quota and budget protection.
 */
export interface ServedPage {
  method: string;
  fetchMode: string | null;
  fetchDest: string | null;
  fetchSite: string | null;
  status: number;
  /** The answer is a page: an HTML file of a site or a document's rendered page. */
  isPage: boolean;
  /** The answer is the redirect that sends a top-level visit to the viewer. */
  viewerRedirect: boolean;
  /** The signed-in visitor a read or review session names; null for an anonymous visit. */
  visitorId: string | null;
  ownerId: string;
  /** The owner's plan includes analytics (from the delivery lookup, no read of its own). */
  analytics: boolean;
}

export type ViewKind = "anonymous" | "signedIn";

const COUNTED_STATUS = new Set([200, 206, 304]);
const FRAME_DESTS = new Set(["iframe", "frame"]);

/**
 * The kind of view a served request is, or null when it is not one. One visit is one view:
 *
 * - With the Portifact bar on, the top-level visit is answered with the redirect to the viewer
 *   and the viewer's frame then loads the page: the frame's load is the view, the redirect is
 *   not. A visit that starts at the viewer reaches delivery only through the frame and counts too.
 * - With the bar off (or the visitor's opt-out), the top-level document is the view, and every
 *   further page of a site is another page view.
 * - Subresources, fetches, files that are not pages and `HEAD` are never views.
 * - A frame a sibling artifact opens (`Sec-Fetch-Site: same-site`) is not a view: its
 *   `frame-ancestors` keeps it from rendering, the same rule as the access log's page loads.
 *   Another site's frame of an embeddable artifact is a view: the page is shown there.
 * - Clients without fetch metadata (crawlers, link previews, command-line tools) never count.
 * - Only 200, 206 and 304 count: refusals, 404, 429 and the redirect do not.
 * - The owner's own visit with a session is not a view. For a workspace, whose admins and editors
 *   are the owner side, the batch drops their views when it is written (`recordViews`).
 * - Nothing counts for an owner whose plan does not include analytics.
 */
export function pageView(page: ServedPage): ViewKind | null {
  if (!page.analytics || page.viewerRedirect || !page.isPage) return null;
  if (page.method !== "GET" || page.fetchMode !== "navigate") return null;
  if (!COUNTED_STATUS.has(page.status)) return null;
  const topLevel = page.fetchDest === "document";
  const shownFrame = FRAME_DESTS.has(page.fetchDest ?? "") && page.fetchSite !== "same-site";
  if (!topLevel && !shownFrame) return null;
  if (page.visitorId === null) return "anonymous";
  if (page.visitorId === page.ownerId) return null;
  return "signedIn";
}

/** The free plan's retention, which every owner falls back to when a paid plan ends. */
export const FREE_RETENTION_DAYS = PLANS.free.limits.accessLogRetentionDays;

/** What decides how long an owner's analytics and access log rows are kept. */
export type RetentionPlan = Pick<
  Entitlements,
  "limits" | "validUntil" | "grace" | "ownAccessLogDays"
>;

/** A retention in force until a moment (null: with no end). */
export interface RetentionHold {
  days: number;
  until: number | null;
}

/**
 * The access log retentions in force for an owner, each until it ends: the plan's own (until its
 * hold after `validUntil` ends, decision 0022) and each running grace's. The retention in force
 * at a moment is the highest of those not ended; once all have ended, the free plan's.
 */
export function accessLogHolds(plan: RetentionPlan): RetentionHold[] {
  const own = plan.ownAccessLogDays ?? plan.limits.accessLogRetentionDays;
  const holds: RetentionHold[] = [
    { days: own, until: plan.validUntil === null ? null : plan.validUntil + PLAN_GRACE_MS },
  ];
  for (const slot of plan.grace?.slots ?? []) {
    holds.push({ days: slot.limits.accessLogRetentionDays, until: slot.until });
  }
  return holds;
}

/**
 * The steps of the retention in force over time: from `from` (null: the beginning) until
 * `until` (null: no end), `days`: the highest hold not ended, then the free plan's once every hold
 * has ended.
 */
export function retentionSteps(
  holds: readonly RetentionHold[],
): { from: number | null; until: number | null; days: number }[] {
  const ends = [...new Set(holds.flatMap((h) => (h.until === null ? [] : [h.until])))].sort(
    (a, b) => a - b,
  );
  const steps: { from: number | null; until: number | null; days: number }[] = [];
  let from: number | null = null;
  for (const until of [...ends, null]) {
    const running = holds.filter((h) => h.until === null || (until !== null && h.until >= until));
    const days =
      running.length === 0 ? FREE_RETENTION_DAYS : Math.max(...running.map((h) => h.days));
    steps.push({ from, until, days });
    from = until;
  }
  return steps;
}

/**
 * When a row whose retention starts at `base` expires: the first moment its age reaches the
 * retention in force then. With one plan that does not end that is `base` plus its
 * `accessLogRetentionDays`; a plan that ends, or a grace (decision 0022), keeps it no longer than
 * its hold, and never less than what is in force after it, so no job is needed when a hold ends.
 */
export function retentionExpiry(base: number, plan: RetentionPlan): number {
  for (const step of retentionSteps(accessLogHolds(plan))) {
    const at = Math.max(step.from ?? base, base + step.days * DAY_MS);
    if (step.until === null || at < step.until) return at;
  }
  // The last step never ends, so the loop always returns.
  return base + FREE_RETENTION_DAYS * DAY_MS;
}

/** A day's view counters are kept for the whole retention after the day ends. */
export function viewsExpireAt(day: number, plan: RetentionPlan): number {
  return retentionExpiry(utcDay(day) + DAY_MS, plan);
}

export interface StatsRangeInput {
  /** First and last day asked for, `YYYY-MM-DD`, both optional and inclusive. */
  from?: string | undefined;
  to?: string | undefined;
  now: number;
  /** The owner's `accessLogRetentionDays` now. */
  retentionDays: number;
}

/**
 * The days one read returns: the last 30 by default, never past today or before what the
 * owner's plan keeps, at most `ANALYTICS.maxRangeDays`. A reversed range, one too long or one
 * with no day left after clamping is `invalid_input`.
 */
export function statsRange(input: StatsRangeInput): Result<{ from: number; to: number }> {
  const today = utcDay(input.now);
  const askedTo = input.to === undefined ? today : parseDay(input.to);
  const askedFrom =
    input.from === undefined
      ? Math.min(askedTo, today) - (ANALYTICS.defaultDays - 1) * DAY_MS
      : parseDay(input.from);
  if (askedFrom > askedTo) return fail("invalid_input", "The range ends before it starts.");
  if ((askedTo - askedFrom) / DAY_MS + 1 > ANALYTICS.maxRangeDays) {
    return fail("invalid_input", `The range is longer than ${ANALYTICS.maxRangeDays} days.`);
  }
  const from = Math.max(askedFrom, today - input.retentionDays * DAY_MS);
  const to = Math.min(askedTo, today);
  if (from > to) {
    return fail(
      "invalid_input",
      `The range has no day in the last ${input.retentionDays} days your plan keeps.`,
    );
  }
  return ok({ from, to });
}
