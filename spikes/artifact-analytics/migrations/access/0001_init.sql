-- Spike S3. The access log database (`portifact-access`), with the two changes the design adds:
-- the daily view counters, and an expiry per row so retention follows the owner's plan.

-- Today's table plus `expires_at` (opened_at + the owner's retention when it was written) and an
-- index by owner, so a downgrade can shorten an owner's rows.
CREATE TABLE `access_events` (
  `artifact_id` text NOT NULL,
  `window_start` integer NOT NULL,
  `user_id` text NOT NULL,
  `owner_id` text NOT NULL,
  `email` text NOT NULL,
  `opened_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  PRIMARY KEY (`artifact_id`, `window_start`, `user_id`)
);
CREATE INDEX `access_events_user_idx` ON `access_events` (`user_id`);
CREATE INDEX `access_events_expires_idx` ON `access_events` (`expires_at`);
CREATE INDEX `access_events_owner_idx` ON `access_events` (`owner_id`);

-- One row per artifact and UTC day with at least one view. WITHOUT ROWID makes the primary key
-- the table, so an upsert that only adds to the counters writes one row (no separate key index),
-- and the secondary indexes are written only when the row is first inserted, because their
-- columns never change on conflict (expires_at only grows on a plan upgrade, see record.ts).
CREATE TABLE `artifact_views` (
  `artifact_id` text NOT NULL,
  `day` integer NOT NULL,
  `owner_id` text NOT NULL,
  `views` integer NOT NULL,
  `signed_in_views` integer NOT NULL,
  `expires_at` integer NOT NULL,
  PRIMARY KEY (`artifact_id`, `day`),
  CHECK (`views` >= 0 AND `signed_in_views` >= 0 AND `signed_in_views` <= `views`)
) WITHOUT ROWID;
CREATE INDEX `artifact_views_expires_idx` ON `artifact_views` (`expires_at`);
CREATE INDEX `artifact_views_owner_idx` ON `artifact_views` (`owner_id`);
