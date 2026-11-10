// Read use cases for an owner's artifacts: list with a cursor and look one up. Someone else's
// artifact looks exactly like a missing one.
import type { ApprovalSummary, ArtifactListFilters } from "@portifact/contracts";
import { type Db, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  authorize,
  fail,
  ok,
  type Result,
  type VersionRetention,
  versionRetention,
} from "@portifact/domain";
import {
  and,
  type Column,
  desc,
  eq,
  getTableColumns,
  getTableName,
  lt,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { authorizeOn } from "./actors.ts";
import { approvalReviewColumn, approvalSummaryOf } from "./approval-reviews.ts";
import { ownerEntitlements } from "./plans.ts";
import { retainedVersionSql } from "./retention.ts";

export type ArtifactRow = typeof schema.artifacts.$inferSelect;

/**
 * Consumption and activity of a listed artifact, read with the page. Traffic is counted per
 * account (`traffic_counters`), never per artifact, so it is not here.
 */
export interface ArtifactActivity {
  /** Committed versions that can still be read, the current one included. */
  versions: number;
  /** Bytes of the current version, published files and sources; null without one. */
  currentBytes: number | null;
  /** Open threads on the current version. */
  openThreads: number;
  /** When a thread on any version last changed (a comment, reply, resolution or moderation). */
  lastAnnotationAt: number | null;
}

/** An artifact with its approval review block (status and counts, no names; decision 0012). */
export type ReviewedArtifact = ArtifactRow & { review: ApprovalSummary };

export type ListedArtifact = ReviewedArtifact & { activity: ArtifactActivity };

export interface ListInput {
  /** The user acting on the owner whose artifacts are listed (from `resolveActor`). */
  actor: Actor;
  cursor?: string | undefined;
  limit: number;
  /** Only artifacts that match every filter given; a cursor continues the same filters. */
  filters?: ArtifactListFilters | undefined;
  /** Decides which previous versions are still retained. */
  now: number;
}

export interface ArtifactPage {
  items: ListedArtifact[];
  nextCursor: string | null;
}

/** Opaque cursor: the sort key of the last item, `<updatedAt>.<id>` in base64url. */
export function encodeCursor(row: Pick<ArtifactRow, "updatedAt" | "id">): string {
  return btoa(`${row.updatedAt}.${row.id}`)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeCursor(cursor: string): { updatedAt: number; id: string } | undefined {
  try {
    const text = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    const match = /^(\d{1,15})\.([a-z2-7]{10})$/.exec(text);
    if (!match) return undefined;
    return { updatedAt: Number(match[1]), id: match[2] as string };
  } catch {
    return undefined;
  }
}

/**
 * The search and filters as conditions. SQLite's `lower` folds only A to Z, so the search
 * ignores case for those letters and matches any other character exactly; IDs are lowercase.
 */
function filterConditions(filters: ArtifactListFilters = {}) {
  const t = schema.artifacts;
  const search = filters.search;
  return [
    search === undefined
      ? undefined
      : or(
          sql`instr(lower(${t.name}), lower(${search})) > 0`,
          sql`instr(${t.id}, lower(${search})) > 0`,
        ),
    filters.state === undefined ? undefined : eq(t.state, filters.state),
    filters.type === undefined ? undefined : eq(t.type, filters.type),
    filters.access === undefined ? undefined : eq(t.accessMode, filters.access),
    filters.annotations === undefined ? undefined : eq(t.annotations, filters.annotations),
    filters.key === undefined ? undefined : eq(t.externalKey, filters.key),
  ];
}

/** The artifacts a service token's restriction reaches (decision 0011); nothing for people. */
function reachConditions(actor: Actor): SQL | undefined {
  const t = schema.artifacts;
  const restriction = actor.token?.restriction;
  if (!restriction || restriction.kind === "none") return undefined;
  if (restriction.kind === "own") return eq(t.createdBy, actor.userId);
  // substr, not like: `_` and `%` are allowed in keys and would be wildcards.
  return sql`substr(${t.externalKey}, 1, ${restriction.prefix.length}) = ${restriction.prefix}`;
}

/**
 * One correlated subquery per figure, each on an index: `versions_artifact_number_idx` for the
 * versions, the primary key for the current version, `annotation_threads_artifact_version_state_idx`
 * for open threads and `annotation_threads_artifact_change_idx` for the last change (the thread
 * changed last has the highest `change_seq`). They run only for the rows of the page.
 */
function activityColumns(retention: VersionRetention, now: number) {
  // Drizzle leaves columns unqualified in select fields, where they would bind to the
  // subquery's own table, so every column here names its table.
  const col = (column: Column) =>
    sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
  const t = schema.artifacts;
  const v = schema.versions;
  const th = schema.annotationThreads;
  const id = col(t.id);
  const current = col(t.currentVersionId);
  return {
    activityVersions: sql<number>`(select count(*) from ${v} where ${col(v.artifactId)} = ${id} and ${retainedVersionSql(current, retention, now)})`,
    activityCurrentBytes: sql<
      number | null
    >`(select ${col(v.publishedBytes)} + ${col(v.sourceBytes)} from ${v} where ${col(v.id)} = ${current})`,
    activityOpenThreads: sql<number>`(select count(*) from ${th} where ${col(th.artifactId)} = ${id} and ${col(th.versionId)} = ${current} and ${col(th.state)} = 'open')`,
    activityLastAnnotationAt: sql<
      number | null
    >`(select ${col(th.updatedAt)} from ${th} where ${col(th.artifactId)} = ${id} order by ${col(th.changeSeq)} desc limit 1)`,
    approvalReview: approvalReviewColumn(id),
  };
}

/**
 * The owner's artifacts that match the filters, most recently updated first, each with its
 * activity. Deleted artifacts are not listed. Listing is for admins and editors of the owner.
 */
export async function listArtifacts(db: Db, input: ListInput): Promise<Result<ArtifactPage>> {
  const allowed = authorize(input.actor, "list");
  if (!allowed.ok) return allowed;
  const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (input.cursor !== undefined && !after) return fail("invalid_input", "Invalid cursor.");
  const t = schema.artifacts;
  // Every listed artifact has the actor's owner, so one plan decides their retention.
  const retention = versionRetention(
    (await ownerEntitlements(db, input.actor.ownerId, input.now)).limits,
  );
  const rows = await db
    .select({ ...getTableColumns(t), ...activityColumns(retention, input.now) })
    .from(t)
    .where(
      and(
        eq(t.ownerId, input.actor.ownerId),
        ne(t.state, "deleted"),
        ne(t.state, "draft"),
        ...filterConditions(input.filters),
        reachConditions(input.actor),
        after
          ? or(
              lt(t.updatedAt, after.updatedAt),
              and(eq(t.updatedAt, after.updatedAt), lt(t.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(t.updatedAt), desc(t.id))
    .limit(input.limit + 1);
  const items = rows
    .slice(0, input.limit)
    .map(
      ({
        activityVersions,
        activityCurrentBytes,
        activityOpenThreads,
        activityLastAnnotationAt,
        approvalReview,
        ...row
      }) => ({
        ...row,
        review: approvalSummaryOf(approvalReview),
        activity: {
          versions: Number(activityVersions),
          currentBytes: activityCurrentBytes === null ? null : Number(activityCurrentBytes),
          openThreads: Number(activityOpenThreads),
          lastAnnotationAt:
            activityLastAnnotationAt === null ? null : Number(activityLastAnnotationAt),
        },
      }),
    );
  const last = items.at(-1);
  return ok({ items, nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null });
}

/**
 * One artifact, for an admin or editor of its owner. Missing, deleted and artifacts of an owner
 * the user has no role on give the same `not_found`.
 */
export async function getArtifact(
  db: RegionalDb,
  input: { userId: string; artifactId: string },
): Promise<Result<ReviewedArtifact>> {
  const missing = () => fail<never>("not_found", "Artifact not found.");
  const t = schema.artifacts;
  const [found] = await db
    .select({
      ...getTableColumns(t),
      approvalReview: approvalReviewColumn(
        sql`${sql.identifier(getTableName(t))}.${sql.identifier(t.id.name)}`,
      ),
    })
    .from(t)
    .where(eq(t.id, input.artifactId))
    .limit(1);
  if (!found || found.state === "deleted") return missing();
  const { approvalReview, ...row } = found;
  const actor = await authorizeOn(db, input.userId, row, "list", missing);
  if (!actor.ok) return actor;
  return ok({ ...row, review: approvalSummaryOf(approvalReview) });
}
