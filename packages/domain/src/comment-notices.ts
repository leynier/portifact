// Comment notices (premium plan section 5, P5): people hear about new comment activity by email
// instead of having to open the viewer. On artifacts whose owner's plan includes
// `commentNotices`, a new thread, a reply or a resolution is pending activity for the owner side
// (the user of a personal space, or a workspace's admins and editors) and for the thread's
// participants (its author and everyone who wrote in it), never for the person who acted. A
// recipient gets one digest at most every `windowMs`, grouping every artifact with activity;
// the digest holds counts per artifact, never text or names of people.
import type { PlanFeature } from "@portifact/contracts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const COMMENT_NOTICE = {
  /**
   * How long activity settles before its digest: a recipient's notice goes out once their oldest
   * pending activity is this old, with everything pending then. Activity after a digest is newer
   * than it, so the next digest is at least this long after the previous one.
   */
  windowMs: 10 * MINUTE_MS,
  /** Recipients one scheduled run schedules digests for at most; the rest wait for the next run. */
  recipientsPerRun: 25,
  /** Artifacts one email lists by name at most; the rest are counted in one line. */
  artifactsListed: 20,
  /** How long an unsubscribe link works. */
  unsubscribeTtlMs: 60 * DAY_MS,
} as const;

/** The plan feature that turns comment notices on for an owner's artifacts. */
export const COMMENT_NOTICE_FEATURE: PlanFeature = "commentNotices";

/** Comment writes that are activity for a notice, and what each one counts as. */
export type NoticeActivity = "thread" | "reply" | "resolved";

/** The counts one write adds to each recipient's pending row of its thread. */
export function activityCounts(activity: NoticeActivity): {
  created: number;
  replies: number;
  resolved: number;
} {
  return {
    created: activity === "thread" ? 1 : 0,
    replies: activity === "reply" ? 1 : 0,
    resolved: activity === "resolved" ? 1 : 0,
  };
}

/**
 * Who a write is pending activity for: the owner side always, the thread's participants for a
 * reply or a resolution (a new thread has no one else yet), each once, and never the actor.
 */
export function commentNoticeRecipients(input: {
  actorId: string;
  ownerSide: readonly string[];
  participants: readonly string[];
  activity: NoticeActivity;
}): string[] {
  const everyone = [...input.ownerSide, ...(input.activity === "thread" ? [] : input.participants)];
  return [...new Set(everyone)].filter((id) => id !== input.actorId);
}

/** The time before which a recipient's oldest pending activity makes them due for a digest. */
export function commentNoticeSettledBefore(now: number): number {
  return now - COMMENT_NOTICE.windowMs;
}

/** Whether a recipient whose oldest pending activity happened at `firstAt` gets a digest now. */
export function commentNoticeDue(firstAt: number, now: number): boolean {
  return firstAt <= commentNoticeSettledBefore(now);
}

/** One thread's pending activity, as the job carries it. */
export interface ThreadActivity {
  artifactId: string;
  threadId: string;
  created: number;
  replies: number;
  resolved: number;
}

/** What the digest says about one artifact. */
export interface ArtifactActivity {
  artifactId: string;
  newThreads: number;
  newReplies: number;
  resolvedThreads: number;
}

/**
 * The digest's artifacts from the threads the recipient may still see: counts summed per
 * artifact, artifacts with nothing left dropped, the most active first (then by ID, so the
 * order is stable).
 */
export function groupActivity(
  threads: readonly ThreadActivity[],
  visible: (thread: ThreadActivity) => boolean,
): ArtifactActivity[] {
  const byArtifact = new Map<string, ArtifactActivity>();
  for (const thread of threads) {
    if (!visible(thread)) continue;
    const entry = byArtifact.get(thread.artifactId) ?? {
      artifactId: thread.artifactId,
      newThreads: 0,
      newReplies: 0,
      resolvedThreads: 0,
    };
    entry.newThreads += thread.created;
    entry.newReplies += thread.replies;
    entry.resolvedThreads += thread.resolved;
    byArtifact.set(thread.artifactId, entry);
  }
  // Each artifact appears once, so two IDs are never equal.
  return [...byArtifact.values()]
    .filter((entry) => activityTotal(entry) > 0)
    .sort((x, y) => activityTotal(y) - activityTotal(x) || (x.artifactId < y.artifactId ? -1 : 1));
}

/** Everything that happened on one artifact, for ordering. */
export function activityTotal(entry: ArtifactActivity): number {
  return entry.newThreads + entry.newReplies + entry.resolvedThreads;
}

/**
 * Whether an unsubscribe link issued at `issuedAt` may still change the preference: not from the
 * future, not older than its lifetime, and not older than the preference's last change, so a
 * link never undoes a later choice to turn the notices back on.
 */
export function unsubscribeUsable(
  issuedAt: number,
  changedAt: number | null,
  now: number,
): boolean {
  return (
    issuedAt <= now &&
    now - issuedAt <= COMMENT_NOTICE.unsubscribeTtlMs &&
    (changedAt === null || issuedAt > changedAt)
  );
}
