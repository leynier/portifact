// The grace emails (decision 0022, third delivery): each hold of a grace is announced when it
// starts, when 14 days or less are left and when 3 days or less are left. A scan that comes late
// sends only the most urgent moment a hold has reached, once; a moment never goes after a later
// one. Only stored holds are announced (a natural expiry's once the grace scan stores it), only
// holds whose end lets something go (`graceHoldEndDrops`: a hold another covers past its end is
// announced by that one), and an unreadable grace never is: it holds everything, deletes nothing.
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

/**
 * The one email the owner is due now, or null: among the live holds whose most urgent moment
 * reached is later than the one they were last told about, the hold ending first (then the one
 * that started first). Marks of holds no longer announced are dropped from the result; the new
 * mark carries `claim`, the token of the scan that schedules it.
 */
export function graceNoticeDue(
  record: GraceNoticeRecord,
  now: number,
  claim?: string,
): DueGraceNotice | null {
  const live = announcedSlots(record, now).sort((a, b) => a.until - b.until || a.from - b.from);
  const marks = readGraceNotices(record.graceNotices);
  const markOf = (slot: GraceSlot) => marks.find((mark) => sameHold(mark, slot));
  for (const slot of live) {
    const moment = graceNoticeMoment(slot, now);
    if (moment === null) continue;
    const told = markOf(slot);
    if (told !== undefined && graceNoticeRank(told.moment) >= graceNoticeRank(moment)) continue;
    const next = live.flatMap((other): GraceNoticeMark[] => {
      if (other === slot) {
        return [{ from: slot.from, until: slot.until, moment, ...(claim ? { claim } : {}) }];
      }
      const kept = markOf(other);
      return kept ? [kept] : [];
    });
    return { slot, moment, marks: next };
  }
  return null;
}

/**
 * The hold a `plan_grace_notice` job is about, when its email is still due at send time: the
 * grace still holds it, it still ends on that date and that end still lets something go, the
 * moment the job carries is still the most urgent it reached, and the owner's mark for the hold
 * is the one this job's scan wrote (its token). Null makes the email moot: the plan granted again,
 * `--no-grace`, a fold that ended it, a later moment due since (the scan announces that one), or
 * a job whose scan's mark never landed or was replaced (a crash between the two writes, or a
 * concurrent scan that won).
 */
export function graceNoticeStillDue(
  record: GraceNoticeRecord | null,
  notice: GraceNoticePayload,
  now: number,
): GraceSlot | null {
  if (record === null) return null;
  const slot = announcedSlots(record, now).find((held) => sameHold(held, notice));
  if (slot === undefined || graceNoticeMoment(slot, now) !== notice.moment) return null;
  const mark = readGraceNotices(record.graceNotices).find((told) => sameHold(told, notice));
  return mark?.moment === notice.moment && mark.claim === notice.claim ? slot : null;
}
