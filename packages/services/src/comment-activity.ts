// The write side of comment notices (rules in packages/domain/src/comment-notices.ts): the one
// statement a comment, reply or resolution adds to its own claimed batch, so pending activity
// exists exactly when the write does and costs no extra round trip. Nothing is added when the
// artifact owner's plan lacks `commentNotices`: the caller already holds the owner's
// entitlements from loading the artifact.
import { type Db, schema } from "@portifact/db";
import {
  activityCounts,
  COMMENT_NOTICE_FEATURE,
  commentNoticeRecipients,
  type Entitlements,
  hasFeature,
  type NoticeActivity,
} from "@portifact/domain";
import { type SQL, sql } from "drizzle-orm";

export interface ActivityMark {
  /** The artifact owner's entitlements, loaded with the artifact. */
  entitlements: Entitlements;
  artifactId: string;
  threadId: string;
  actorId: string;
  /** The owner side at the write: the user of a personal space, or a workspace's admins and editors. */
  ownerSide: readonly string[];
  activity: NoticeActivity;
  now: number;
  /** The batch's claim: the mark is written only when the write itself happened. */
  claimed: SQL;
}

/**
 * Upserts one pending row per recipient of the thread, adding this write's counts, or returns
 * null when the owner's plan has no comment notices. Recipients are the owner side and, for a
 * reply or a resolution, the thread's participants (its author and everyone who wrote in it, read
 * in the same statement), never the actor and never someone who muted the artifact. Who may see
 * the thread is decided again when the notice is sent, not here.
 */
export function markCommentActivity(db: Db, mark: ActivityMark) {
  if (!hasFeature(mark.entitlements, COMMENT_NOTICE_FEATURE)) return null;
  const counts = activityCounts(mark.activity);
  const fixed = commentNoticeRecipients({
    actorId: mark.actorId,
    ownerSide: mark.ownerSide,
    participants: [],
    activity: mark.activity,
  });
  const th = schema.annotationThreads;
  const m = schema.annotationMessages;
  const mutes = schema.commentNoticeMutes;
  const cn = schema.commentNotices;
  const sources: SQL[] = [
    sql`select null as "id" where 0`,
    ...fixed.map((id) => sql`select ${id}`),
  ];
  if (mark.activity !== "thread") {
    sources.push(
      sql`select ${th.authorId} from ${th} where ${th.id} = ${mark.threadId}`,
      sql`select ${m.authorId} from ${m} where ${m.threadId} = ${mark.threadId}`,
    );
  }
  // Columns in schema order: recipient, thread, artifact, created, replies, resolved, first_at.
  return db
    .insert(cn)
    .select(
      sql`select "r"."id", ${mark.threadId}, ${mark.artifactId}, ${counts.created}, ${counts.replies}, ${counts.resolved}, ${mark.now} from (${sql.join(sources, sql` union `)}) as "r" where "r"."id" is not null and "r"."id" <> ${mark.actorId} and ${mark.claimed} and not exists (select 1 from ${mutes} where ${mutes.artifactId} = ${mark.artifactId} and ${mutes.userId} = "r"."id")`,
    )
    .onConflictDoUpdate({
      target: [cn.recipientId, cn.threadId],
      set: {
        created: sql`max(${cn.created}, excluded."created")`,
        replies: sql`min(200, ${cn.replies} + excluded."replies")`,
        resolved: sql`max(${cn.resolved}, excluded."resolved")`,
      },
    });
}
