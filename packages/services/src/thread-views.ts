// Thread views: a thread with its messages and their authors, as every annotation read path
// returns it (the per-artifact list, one thread, the export and a space's open feedback). Bodies
// are untrusted data; a hidden message's body is shown only to the owner and its author.
import type {
  AnnotationAuthor,
  AnnotationMessageView,
  AnnotationTarget,
  AnnotationThreadView,
  ImageRegion,
  ImageRegionView,
  AttachmentView,
  SuggestionThreadView,
} from "@portifact/contracts";
import { type RegionalDb, schema } from "@portifact/db";
import { type AnnotationRole, ERASED_ACCOUNT, messageBodyVisible } from "@portifact/domain";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { suggestionView } from "./suggestion-view.ts";
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
  /**
   * Adds each thread's `kind` and, for a suggestion, its `suggestion` block: only when the client
   * asked (`?fields=suggestion`), so released clients that validate strictly never see them.
   */
  suggestionFields?: boolean;
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
): Promise<(AnnotationThreadView | SuggestionThreadView)[]> {
  if (threads.length === 0) return [];
  const m = schema.annotationMessages;
  const messages: MessageRow[] = [];
  const issues = new Map<string, ThreadIssueRecord[]>();
  const files = new Map<string, AttachmentView[]>();
  const ca = schema.commentAttachments;
  for (const ids of chunks(threads.map((thread) => thread.id))) {
    // The thread's issues and files ride in the messages' call (decisions 0018 and 0028): no
    // round trip of their own.
    const [rows, issueRows, fileRows] = await db.batch([
      db
        .select()
        .from(m)
        .where(inArray(m.threadId, ids))
        .orderBy(asc(m.createdAt), sql`${m}.rowid`),
      threadIssuesQuery(db, ids, viewerId),
      db
        .select({
          id: ca.id,
          messageId: ca.messageId,
          name: ca.name,
          contentType: ca.contentType,
          size: ca.size,
          sha256: ca.sha256,
        })
        .from(ca)
        .where(
          // A file the operator withholds is listed to nobody until reinstated (decision 0028).
          and(inArray(ca.threadId, ids), eq(ca.state, "attached"), isNull(ca.withheldAt)),
        )
        .orderBy(asc(ca.attachedAt), asc(ca.id)),
    ]);
    messages.push(...rows);
    for (const file of fileRows) {
      if (file.messageId === null || file.contentType === null) continue;
      const list = files.get(file.messageId) ?? [];
      list.push({
        id: file.id,
        name: file.name,
        contentType: file.contentType,
        size: file.size,
        sha256: file.sha256,
      });
      files.set(file.messageId, list);
    }
    for (const row of issueRows) {
      const list = issues.get(row.threadId) ?? [];
      list.push(threadIssueRecord(row, viewerId));
      issues.set(row.threadId, list);
    }
  }
  const regions = await regionViews(db, context, threads);
  // The erased account (`ERASED_ACCOUNT`) names nobody: it is never looked up.
  const authorIds = [
    ...new Set([...threads.map((t) => t.authorId), ...messages.map((x) => x.authorId)]),
  ].filter((id) => id !== ERASED_ACCOUNT);
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
    const visible = messageBodyVisible(context.role, viewerId, message);
    const attached = visible ? files.get(message.id) : undefined;
    byThread.get(message.threadId)?.push({
      id: message.id,
      author: authors.get(message.authorId) ?? null,
      own: message.authorId === viewerId,
      state: message.state,
      body: visible ? message.body : null,
      revision: message.revision,
      createdAt: iso(message.createdAt),
      editedAt: message.editedAt === null ? null : iso(message.editedAt),
      // Only when it has files and the caller sees its body, so a hidden message shows none.
      ...(attached && attached.length > 0 ? { attachments: attached } : {}),
    });
  }
  return threads.map((thread) => ({
    id: thread.id,
    versionId: thread.versionId,
    current: thread.versionId === context.currentVersionOf(thread.artifactId),
    path: thread.path,
    target: JSON.parse(thread.target) as AnnotationTarget,
    ...(regions.has(thread.id) ? { region: regions.get(thread.id) as ImageRegionView } : {}),
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
    ...(context.suggestionFields
      ? {
          kind: thread.kind,
          suggestion: thread.kind === "suggestion" ? suggestionView(thread) : null,
        }
      : {}),
  }));
}

/**
 * Each region thread's region (decision 0028). A thread of another version than the current one
 * also says whether the current version still has the same bytes at the image's path, read for all
 * of them at once: one query per chunk of (current version, path) pairs, and none without such a
 * thread.
 */
async function regionViews(
  db: RegionalDb,
  context: ThreadViewContext,
  threads: readonly ThreadRow[],
): Promise<Map<string, ImageRegionView>> {
  const views = new Map<string, ImageRegionView>();
  const history: { threadId: string; versionId: string; region: ImageRegion }[] = [];
  for (const thread of threads) {
    if (thread.region === null) continue;
    const region = JSON.parse(thread.region) as ImageRegion;
    views.set(thread.id, region);
    const current = context.currentVersionOf(thread.artifactId);
    if (current !== null && current !== thread.versionId) {
      history.push({ threadId: thread.id, versionId: current, region });
    } else if (current === null) {
      // No current version (archived or gone): nothing to compare with, so the image changed.
      views.set(thread.id, { ...region, currentImage: "changed" });
    }
  }
  if (history.length === 0) return views;
  const vf = schema.versionFiles;
  const key = (versionId: string, path: string) => JSON.stringify([versionId, path]);
  const pairs = [
    ...new Map(history.map((h) => [key(h.versionId, h.region.image.path), h] as const)).values(),
  ];
  const found = new Map<string, string>();
  // Two parameters per pair, so half a chunk keeps each statement under D1's 100.
  for (let i = 0; i < pairs.length; i += IN_CHUNK / 2) {
    const rows = await db
      .select({ versionId: vf.versionId, path: vf.path, sha256: vf.sha256 })
      .from(vf)
      .where(
        and(
          eq(vf.kind, "published"),
          or(
            ...pairs
              .slice(i, i + IN_CHUNK / 2)
              .map((p) => and(eq(vf.versionId, p.versionId), eq(vf.path, p.region.image.path))),
          ),
        ),
      );
    for (const row of rows) found.set(key(row.versionId, row.path), row.sha256);
  }
  for (const h of history) {
    const sha = found.get(key(h.versionId, h.region.image.path));
    views.set(h.threadId, {
      ...h.region,
      currentImage: sha === h.region.image.sha256 ? "unchanged" : "changed",
    });
  }
  return views;
}
