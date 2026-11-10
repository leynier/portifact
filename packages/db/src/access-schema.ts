// Schema of the access log database (`portifact-access`, plan section 14: `access_events` lives
// in a D1 database of its own). Deduplicated openings of artifacts by signed-in visitors, written
// by the content Worker in batches, read by the owner through the API and pruned after 30 days by
// the jobs Worker. It has no foreign keys into the control database: purges and account
// deletions erase their rows through `erase_access_events` jobs of the control outbox.
// Timestamps are integer milliseconds since the epoch (UTC).
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "number" });

/**
 * One row per artifact, visitor and 30-minute window (`window_start`), so the key itself
 * deduplicates openings from every isolate. `opened_at` is the earliest opening recorded in the
 * window and `email` the visitor's verified address at that time; only the owner reads it.
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
  },
  (t) => [
    // Also the owner's listing order: newest window first, within an artifact.
    primaryKey({ columns: [t.artifactId, t.windowStart, t.userId] }),
    index("access_events_user_idx").on(t.userId),
    index("access_events_opened_idx").on(t.openedAt),
  ],
);
