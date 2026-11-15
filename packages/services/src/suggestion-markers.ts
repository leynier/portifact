// Restore markers of edit suggestions (decision 0027, "Withdrawal, deletion and retention"): what
// keeps a withdrawn or rejected suggestion so, and a removed draft gone, through a D1 Time Travel
// restore. Each is a window tombstone (`WINDOW_TOMBSTONE_KINDS`, pruned after 30 days) written in
// the batch of the change, on the change's own condition, like a deleted comment's
// (`comment_thread`, `comment_message`); `applyTombstones` re-applies them (`restoreEntries`).
//
// With one database the tombstone itself is in the batch; with a separate regional database a
// `comment_tombstones` job in the regional batch writes it in the global database, as for
// comments. Either way the statement is `select ... <from and where>`, so it writes one marker per
// row the change is about to touch and none when the change's condition fails.
import { type Db, schema } from "@portifact/db";
import { type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

export type SuggestionMarkerKind = "suggestion_withdrawn" | "suggestion_rejected" | "edit_draft";

const dr = schema.editDrafts;

/**
 * A draft's marker ID: its artifact, its author and its incarnation, so a restore deletes that
 * draft again and never one its author started after it (a new incarnation).
 */
export function draftMarkerId(artifactId: string, userId: string, incarnation: string): string {
  return `${artifactId}:${userId}:${incarnation}`;
}

/** The same ID as a SQL expression over `edit_drafts`. */
export const DRAFT_MARKER_SQL = sql`${dr.artifactId} || ':' || ${dr.userId} || ':' || ${dr.incarnation}`;

/**
 * One marker statement. `id` is an expression over the rows `source` selects (`from ... where
 * ...`, always with a `where`: SQLite reads `on conflict` after a bare `from` as part of the
 * join), `artifactId` the expression naming the artifact the job is about. `shared` is whether the
 * batch runs on the handle that writes both databases (`bothSides`), which `x` must then be.
 */
export function suggestionMarker(
  x: Db,
  shared: boolean,
  marker: { kind: SuggestionMarkerKind; id: SQL; artifactId: SQL; source: SQL },
  now: number,
): BatchItem<"sqlite"> {
  if (shared) {
    // Columns in schema order: kind, id, deleted at.
    return x
      .insert(schema.tombstones)
      .select(sql`select ${marker.kind}, ${marker.id}, ${now} ${marker.source}`)
      .onConflictDoNothing();
  }
  // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
  // subject, generation.
  return x
    .insert(schema.outbox)
    .select(
      sql`select null, 'comment_tombstones', json_object('ids', json('[]'), 'markers', json_array(json_object('kind', ${marker.kind}, 'id', ${marker.id})), 'at', ${now}), ${now}, null, 0, ${now}, ${marker.artifactId}, null ${marker.source}`,
    );
}

/** The marker of a draft about to be removed: one per row `where` selects of `edit_drafts`. */
export function draftMarker(x: Db, shared: boolean, where: SQL, now: number): BatchItem<"sqlite"> {
  return suggestionMarker(
    x,
    shared,
    {
      kind: "edit_draft",
      id: DRAFT_MARKER_SQL,
      artifactId: sql`${dr.artifactId}`,
      source: sql`from ${dr} where ${where}`,
    },
    now,
  );
}

/** The marker of a suggestion about to be withdrawn or rejected, when `condition` holds. */
export function decisionMarker(
  x: Db,
  shared: boolean,
  kind: "suggestion_withdrawn" | "suggestion_rejected",
  thread: { id: string; artifactId: string },
  condition: SQL,
  now: number,
): BatchItem<"sqlite"> {
  return suggestionMarker(
    x,
    shared,
    {
      kind,
      id: sql`${thread.id}`,
      artifactId: sql`${thread.artifactId}`,
      source: sql`where ${condition}`,
    },
    now,
  );
}
