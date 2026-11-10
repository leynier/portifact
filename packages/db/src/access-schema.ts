// Schema of the access log database (`portifact-access`, plan section 14: `access_events` lives
// in a D1 database of its own). Deduplicated openings of artifacts by signed-in visitors and the
// daily view counters of artifacts on plans with analytics (decision 0007), both written by the
// content Worker in batches, read by the owner through the API and pruned by the jobs Worker once
// each row's `expires_at` passes, which follows the owner's plan (`accessLogRetentionDays`). It
// has no foreign keys into the control database: purges and account deletions erase their rows
// through `erase_access_events` jobs of the control outbox, and plan changes move the expiries
// through `owner_retention` jobs. Timestamps are integer milliseconds since the epoch (UTC).

import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "number" });

/**
 * One row per artifact, visitor and 30-minute window (`window_start`), so the key itself
 * deduplicates openings from every isolate. `opened_at` is the earliest opening recorded in the
 * window and `email` the visitor's verified address at that time; only the owner reads it.
 * `expires_at` is when the prune deletes the row, from the owner's plan when it was written (see
 * `retentionExpiry` in @portifact/domain); null only on rows a Worker older than migration 0001
 * wrote, which keep the free 30 days.
 */
export const accessEvents = sqliteTable(
  "access_events",
  {
    artifactId: text("artifact_id").notNull(),
    windowStart: timestamp("window_start").notNull(),
    userId: text("user_id").notNull(),
    ownerId: text("owner_id").notNull(),
    email: text("email").notNull(),
    openedAt: timestamp("opened_at").notNull(),
    /**
     * Set for an opening through a share link (decision 0008): `user_id` then holds the link's ID
     * too and `email` is empty, because a link names no one.
     */
    linkId: text("link_id"),
    expiresAt: timestamp("expires_at"),
  },
  (t) => [
    // Also the owner's listing order: newest window first, within an artifact.
    primaryKey({ columns: [t.artifactId, t.windowStart, t.userId] }),
    index("access_events_user_idx").on(t.userId),
    index("access_events_expires_idx").on(t.expiresAt),
    index("access_events_owner_idx").on(t.ownerId),
  ],
);

/**
 * Page views of one artifact on one UTC day (`day`, the day's first instant), for owners whose
 * plan includes analytics. Counts only: no visitor, IP address or hash. `signed_in_views` counts
 * the views that came with a session. The content Worker adds to the row once per window per
 * isolate (`recordViews`), so concurrent and retried batches add up. The migration makes the
 * table `WITHOUT ROWID`, so an upsert that only adds to the counters writes one row.
 */
export const artifactViews = sqliteTable(
  "artifact_views",
  {
    artifactId: text("artifact_id").notNull(),
    day: timestamp("day").notNull(),
    ownerId: text("owner_id").notNull(),
    views: integer("views").notNull(),
    signedInViews: integer("signed_in_views").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.day] }),
    index("artifact_views_expires_idx").on(t.expiresAt),
    index("artifact_views_owner_idx").on(t.ownerId),
    check(
      "artifact_views_counts",
      sql`${t.views} >= 0 and ${t.signedInViews} >= 0 and ${t.signedInViews} <= ${t.views}`,
    ),
  ],
);
