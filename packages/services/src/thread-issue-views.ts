// How an issue linked to a thread is shown (decision 0018): every thread view reads the links
// through `threadIssuesQuery`, in the same call as the thread's messages. Kept apart from
// ./thread-issues.ts so the thread views do not import the request and job code.
import type {
  IntegrationService,
  ThreadIssueFailure,
  ThreadIssueState,
} from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import { and, asc, eq, inArray, or } from "drizzle-orm";

const ti = schema.threadIssues;
type IssueRow = typeof ti.$inferSelect;

export interface ThreadIssueRecord {
  id: string;
  service: IntegrationService;
  target: string;
  state: ThreadIssueState;
  key: string | null;
  url: string | null;
  failure: ThreadIssueFailure | null;
  own: boolean;
  createdAt: number;
}

export function threadIssueRecord(row: IssueRow, viewerId: string): ThreadIssueRecord {
  return {
    id: row.id,
    service: row.service,
    target: row.targetName,
    state: row.state,
    key: row.issueKey,
    url: row.issueUrl,
    failure: (row.failure as ThreadIssueFailure | null) ?? null,
    own: row.requestedBy === viewerId,
    createdAt: row.createdAt,
  };
}

/**
 * The issues each thread shows to `viewerId`: the created ones, and the viewer's own requests
 * still pending or failed. Callers have already decided the viewer sees the threads.
 */
export function threadIssuesQuery(db: Db, threadIds: readonly string[], viewerId: string) {
  return db
    .select()
    .from(ti)
    .where(
      and(
        inArray(ti.threadId, [...threadIds]),
        or(eq(ti.state, "created"), eq(ti.requestedBy, viewerId)),
      ),
    )
    .orderBy(asc(ti.createdAt), asc(ti.id));
}
