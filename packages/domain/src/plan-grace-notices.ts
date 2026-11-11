// The grace emails (decision 0022, third delivery): each hold of a grace is announced when it
// starts, when 14 days or less are left and when 3 days or less are left. A scan that comes late
// sends only the most urgent moment a hold has reached, once; a moment never goes after a later
// one. Only stored holds are announced (a natural expiry's once the grace scan stores it), only
// holds on whose end a forecast step falls (`graceHoldEndDrops`), and an unreadable grace never
// is: it holds everything and deletes nothing. Several holds due at once share one email.
import {
  GRACE_NOTICE_LEAD_MS,
  GRACE_NOTICE_MOMENTS,
  type GraceNoticeMark,
  GraceNoticeMarks,
  type GraceNoticeMoment,
  type GraceNoticePayload,
  type GraceSlot,
} from "@portifact/contracts";
import { graceHoldEndDrops, type OwnerPlanRecord, readGrace } from "./plans.ts";

/** A plan row with its grace emails' marks (`owner_plans.grace_notices`). */
export interface GraceNoticeRecord extends OwnerPlanRecord {
  graceNotices?: unknown;
}

/** One email to send: the hold, its moment, and the marks to store with it. */
export interface DueGraceNotice {
  slot: GraceSlot;
  moment: GraceNoticeMoment;
  /** The marks after this email: one per live hold that got one, this one included. */
  marks: GraceNoticeMark[];
}

/** How urgent a moment is: 0 for the start, 2 for the last three days. */
export function graceNoticeRank(moment: GraceNoticeMoment): number {
  return GRACE_NOTICE_MOMENTS.indexOf(moment);
}

/** The most urgent moment a hold has reached at `now`, or null once it ended. */
export function graceNoticeMoment(slot: GraceSlot, now: number): GraceNoticeMoment | null {
  const left = slot.until - now;
  if (left <= 0) return null;
  if (left <= GRACE_NOTICE_LEAD_MS.three_days) return "three_days";
  if (left <= GRACE_NOTICE_LEAD_MS.two_weeks) return "two_weeks";
  return "start";
}

/**
 * The stored marks, or none when the value does not read: at most one more email per hold, never
 * a failure. Accepts the column's text or an already parsed list.
 */
export function readGraceNotices(value: unknown): GraceNoticeMark[] {
  if (value === null || value === undefined) return [];
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const parsed = GraceNoticeMarks.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

const sameHold = (a: { from: number; until: number }, b: { from: number; until: number }) =>
  a.from === b.from && a.until === b.until;

/** The stored holds still running at `now` whose end lets something go; none if unreadable. */
function announcedSlots(record: OwnerPlanRecord, now: number): GraceSlot[] {
  const { slots, unreadable } = readGrace(record);
  if (unreadable) return [];
  return slots.filter((slot) => slot.until > now && graceHoldEndDrops(record, slot));
}

/** What the owner's grace emails need this run (`planGraceNotices`). */
export interface GraceNoticePlan {
  /** The one email to send, or null. */
  notice: { slot: GraceSlot; moment: GraceNoticeMoment } | null;
  /** The marks to store with it: one per live hold that got an email or is covered. */
  marks: GraceNoticeMark[];
  /** Whether the marks change (an email, or a covered hold to record), so a write is needed. */
  changed: boolean;
}

/**
 * What the grace emails need now. Every announced hold whose most urgent moment reached is later
 * than what it was told is due; when several are, one email goes, for the most urgent moment among
 * them (then the hold ending first), and each due hold is marked at its own moment with the same
 * token, since that one email lists every step of the forecast. A live hold whose end lets nothing
 * go is marked `covered` (no email) so the scan does not read it again until the holds change.
 */
export function planGraceNotices(
  record: GraceNoticeRecord,
  now: number,
  claim?: string,
): GraceNoticePlan {
  const { slots, unreadable } = readGrace(record);
  const stored = readGraceNotices(record.graceNotices);
  if (unreadable) return { notice: null, marks: stored, changed: false };
  const live = slots
    .filter((slot) => slot.until > now)
    .sort((a, b) => a.until - b.until || a.from - b.from);
  const markOf = (slot: GraceSlot) => stored.find((mark) => sameHold(mark, slot));
  const coveredNow = (mark: GraceNoticeMark | undefined) => mark?.covered === slots.length;
  const told = (slot: GraceSlot) => {
    const mark = markOf(slot);
    if (mark === undefined) return -1;
    if (mark.covered !== undefined) return coveredNow(mark) ? GRACE_NOTICE_MOMENTS.length : -1;
    return graceNoticeRank(mark.moment);
  };
  const due: { slot: GraceSlot; moment: GraceNoticeMoment }[] = [];
  const covered: GraceSlot[] = [];
  for (const slot of live) {
    if (!graceHoldEndDrops(record, slot)) {
      if (!coveredNow(markOf(slot))) covered.push(slot);
      continue;
    }
    const moment = graceNoticeMoment(slot, now);
    if (moment !== null && graceNoticeRank(moment) > told(slot)) due.push({ slot, moment });
  }
  const notice =
    [...due].sort((a, b) => graceNoticeRank(b.moment) - graceNoticeRank(a.moment))[0] ?? null;
  const marks = live.flatMap((slot): GraceNoticeMark[] => {
    const dueNow = due.find((entry) => entry.slot === slot);
    if (dueNow) {
      return [
        { from: slot.from, until: slot.until, moment: dueNow.moment, ...(claim ? { claim } : {}) },
      ];
    }
    if (covered.includes(slot)) {
      return [{ from: slot.from, until: slot.until, moment: "three_days", covered: slots.length }];
    }
    const kept = markOf(slot);
    return kept ? [kept] : [];
  });
  return { notice, marks, changed: due.length > 0 || covered.length > 0 };
}

/**
 * The one email the owner is due now, with the marks to store, or null (`planGraceNotices`
 * without the covered holds' bookkeeping when no email goes).
 */
export function graceNoticeDue(
  record: GraceNoticeRecord,
  now: number,
  claim?: string,
): DueGraceNotice | null {
  const plan = planGraceNotices(record, now, claim);
  return plan.notice === null ? null : { ...plan.notice, marks: plan.marks };
}

/** What a `plan_grace_notice` job does when it runs (`graceNoticeCheck`). */
export type GraceNoticeCheck =
  | { status: "send"; slot: GraceSlot }
  | { status: "wait" }
  | { status: "moot" };

/**
 * Whether a `plan_grace_notice` job sends when it runs: the grace still holds its hold, it still
 * ends on that date and that end still lets something go, the moment it carries is still the most
 * urgent it reached, and the owner's mark for the hold holds the job's token. A mark below the
 * job's moment (or none) means the mark has not landed yet (with a separate regional database the
 * job is written first): the job waits and runs again. Anything else makes it moot: the plan
 * granted again, `--no-grace`, a fold, a later hold covering it, a later moment due since, or a
 * mark with another token (a concurrent scan that won, or the next scan after a crash).
 */
export function graceNoticeCheck(
  record: GraceNoticeRecord | null,
  notice: GraceNoticePayload,
  now: number,
): GraceNoticeCheck {
  if (record === null) return { status: "moot" };
  const slot = announcedSlots(record, now).find((held) => sameHold(held, notice));
  if (slot === undefined || graceNoticeMoment(slot, now) !== notice.moment) {
    return { status: "moot" };
  }
  const mark = readGraceNotices(record.graceNotices).find((told) => sameHold(told, notice));
  if (mark?.moment === notice.moment && mark.claim === notice.claim)
    return { status: "send", slot };
  const landed =
    mark !== undefined &&
    mark.covered === undefined &&
    graceNoticeRank(mark.moment) >= graceNoticeRank(notice.moment);
  return landed ? { status: "moot" } : { status: "wait" };
}

/** `graceNoticeCheck` for a caller that only sends: the hold, or null. */
export function graceNoticeStillDue(
  record: GraceNoticeRecord | null,
  notice: GraceNoticePayload,
  now: number,
): GraceSlot | null {
  const check = graceNoticeCheck(record, notice, now);
  return check.status === "send" ? check.slot : null;
}
