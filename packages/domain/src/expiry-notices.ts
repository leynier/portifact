// Expiry notices (plan section 10: "Los avisos de vencimiento se agrupan por cuenta"). An active
// artifact archives 30 days after its last publish or renewal; a few days before, its owner gets
// one email that lists every artifact of theirs about to expire. Each expiry is notified once: a
// publish or renewal sets a new expiry, which is due for its own notice. An owner gets at most one
// notice a day, so artifacts that enter the window hours apart wait and go out together.
import { EXPIRY_NOTICE_ARTIFACTS_MAX } from "@portifact/contracts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const EXPIRY_NOTICE = {
  /** How long before its expiry an artifact is included in a notice. */
  windowMs: 3 * DAY_MS,
  /**
   * The least time between two notices to the same owner. Shorter than the window, so every
   * artifact is still notified at least two days before it expires.
   */
  ownerCooldownMs: DAY_MS,
  /** Owners one scheduled run schedules notices for at most; the rest wait for the next run. */
  ownersPerRun: 25,
} as const;

export interface NoticeCandidate {
  state: string;
  expiresAt: number | null;
  /** The expiry the owner was already emailed about, if any. */
  expiryNoticeFor: number | null;
}

/** The latest expiry a notice scheduled now includes. */
export function noticeWindowEnd(now: number): number {
  return now + EXPIRY_NOTICE.windowMs;
}

/**
 * Whether an artifact needs a notice now: active, expiring within the window but not yet, and
 * not already notified for this expiry.
 */
export function noticeDue(artifact: NoticeCandidate, now: number): boolean {
  return (
    artifact.state === "active" &&
    artifact.expiresAt !== null &&
    artifact.expiresAt > now &&
    artifact.expiresAt <= noticeWindowEnd(now) &&
    artifact.expiryNoticeFor !== artifact.expiresAt
  );
}

/** Whether the owner's last notice is too recent for another one. */
export function ownerInCooldown(lastNoticeAt: number | null, now: number): boolean {
  return lastNoticeAt !== null && lastNoticeAt > now - EXPIRY_NOTICE.ownerCooldownMs;
}

export interface NoticeEntry {
  id: string;
  expiresAt: number;
}

/**
 * One notice per owner, its artifacts soonest first (then by ID, so the order is stable), at
 * most `EXPIRY_NOTICE_ARTIFACTS_MAX` each; the rest wait for the owner's next notice.
 */
export function groupNotices(
  candidates: readonly (NoticeEntry & { ownerId: string })[],
): Map<string, NoticeEntry[]> {
  const groups = new Map<string, NoticeEntry[]>();
  for (const { ownerId, id, expiresAt } of candidates) {
    const group = groups.get(ownerId) ?? [];
    group.push({ id, expiresAt });
    groups.set(ownerId, group);
  }
  for (const [owner, group] of groups) {
    group.sort((a, b) => a.expiresAt - b.expiresAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    groups.set(owner, group.slice(0, EXPIRY_NOTICE_ARTIFACTS_MAX));
  }
  return groups;
}

/**
 * Whether an artifact a notice was scheduled for still belongs in it when the email goes out:
 * the same owner's, still active, with the expiry it was scheduled for and not yet past.
 */
export function stillExpiring(
  entry: NoticeEntry,
  current: { ownerId: string; state: string; expiresAt: number | null } | undefined,
  ownerId: string,
  now: number,
): boolean {
  return (
    current !== undefined &&
    current.ownerId === ownerId &&
    current.state === "active" &&
    current.expiresAt === entry.expiresAt &&
    entry.expiresAt > now
  );
}
