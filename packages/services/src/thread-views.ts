// Thread views: a thread with its messages and their authors, as every annotation read path
// returns it (the per-artifact list, one thread, the export and a space's open feedback). Bodies
// are untrusted data; a hidden message's body is shown only to the owner and its author.
import type {
  AnnotationAuthor,
  AnnotationMessageView,
  AnnotationTarget,
  AnnotationThreadView,
} from "@portifact/contracts";
import { type RegionalDb, schema } from "@portifact/db";
import { type AnnotationRole, messageBodyVisible } from "@portifact/domain";
import { asc, inArray, sql } from "drizzle-orm";
import {
  type ThreadIssueRecord,
  threadIssueRecord,
  threadIssuesQuery,
} from "./thread-issue-views.ts";

/** D1 binds at most 100 parameters per statement. */
const IN_CHUNK = 90;

export type ThreadRow = typeof schema.annotationThreads.$inferSelect;
type MessageRow = typeof schema.annotationMessages.$inferSelect;

/** How the caller sees the threads: their role, who acts for the owner, each current version. */
export interface ThreadViewContext {
  role: AnnotationRole;
  ownerSide: readonly string[];
  currentVersionOf(artifactId: string): string | null;
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export async function threadViews(
  db: RegionalDb,
  context: ThreadViewContext,
  viewerId: string,
  threads: readonly ThreadRow[],
): Promise<AnnotationThreadView[]> {
  if (threads.length === 0) return [];
  const m = schema.annotationMessages;
  const messages: MessageRow[] = [];
  const issues = new Map<string, ThreadIssueRecord[]>();
  for (const ids of chunks(threads.map((thread) => thread.id))) {
    // The thread's issues ride in the messages' call (decision 0018): no round trip of their own.
    const [rows, issueRows] = await db.batch([
      db
        .select()
        .from(m)
        .where(inArray(m.threadId, ids))
        .orderBy(asc(m.createdAt), sql`${m}.rowid`),
      threadIssuesQuery(db, ids, viewerId),
    ]);
    messages.push(...rows);
    for (const row of issueRows) {
      const list = issues.get(row.threadId) ?? [];
      list.push(threadIssueRecord(row, viewerId));
      issues.set(row.threadId, list);
    }
  }
  const authorIds = [
    ...new Set([...threads.map((t) => t.authorId), ...messages.map((x) => x.authorId)]),
  ];
  const authors = new Map<string, AnnotationAuthor>();
  for (const ids of chunks(authorIds)) {
    // Authors are global accounts (decision 0005): their names come from the global database.
    const users = await db.global
      .select({ id: schema.users.id, name: schema.users.name, image: schema.users.image })
      .from(schema.users)
      .where(inArray(schema.users.id, ids));
    for (const user of users) authors.set(user.id, user);
  }
  const byThread = new Map<string, AnnotationMessageView[]>(
    threads.map((thread) => [thread.id, []]),
  );
  for (const message of messages) {
    byThread.get(message.threadId)?.push({
      id: message.id,
      author: authors.get(message.authorId) ?? null,
      own: message.authorId === viewerId,
      state: message.state,
      body: messageBodyVisible(context.role, viewerId, message) ? message.body : null,
      revision: message.revision,
      createdAt: iso(message.createdAt),
      editedAt: message.editedAt === null ? null : iso(message.editedAt),
    });
  }
  return threads.map((thread) => ({
    id: thread.id,
    versionId: thread.versionId,
    current: thread.versionId === context.currentVersionOf(thread.artifactId),
    path: thread.path,
    target: JSON.parse(thread.target) as AnnotationTarget,
    state: thread.state,
    author: authors.get(thread.authorId) ?? null,
    own: thread.authorId === viewerId,
    byOwner: context.ownerSide.includes(thread.authorId),
    revision: thread.revision,
    createdAt: iso(thread.createdAt),
    updatedAt: iso(thread.updatedAt),
    resolvedAt: thread.resolvedAt === null ? null : iso(thread.resolvedAt),
    messages: byThread.get(thread.id) as AnnotationMessageView[],
    ...(issues.has(thread.id)
      ? {
          issues: (issues.get(thread.id) ?? []).map((issue) => ({
            ...issue,
            createdAt: iso(issue.createdAt),
          })),
        }
      : {}),
  }));
}
