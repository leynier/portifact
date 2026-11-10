-- Analytics per artifact (decision 0007): the daily view counters, WITHOUT ROWID (added by hand,
-- Drizzle does not model it) so an upsert that only adds writes one row, and a per-row expiry on
-- the access log, backfilled with the free 30 days it was kept until now. The backfill covers
-- every row, share-link openings (0001, `link_id` set) included.
CREATE TABLE `artifact_views` (
	`artifact_id` text NOT NULL,
	`day` integer NOT NULL,
	`owner_id` text NOT NULL,
	`views` integer NOT NULL,
	`signed_in_views` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`artifact_id`, `day`),
	CONSTRAINT "artifact_views_counts" CHECK("views" >= 0 and "signed_in_views" >= 0 and "signed_in_views" <= "views")
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `artifact_views_expires_idx` ON `artifact_views` (`expires_at`);--> statement-breakpoint
CREATE INDEX `artifact_views_owner_idx` ON `artifact_views` (`owner_id`);--> statement-breakpoint
DROP INDEX `access_events_opened_idx`;--> statement-breakpoint
ALTER TABLE `access_events` ADD `expires_at` integer;--> statement-breakpoint
UPDATE `access_events` SET `expires_at` = `opened_at` + 2592000000 WHERE `expires_at` IS NULL;--> statement-breakpoint
CREATE INDEX `access_events_expires_idx` ON `access_events` (`expires_at`);--> statement-breakpoint
CREATE INDEX `access_events_owner_idx` ON `access_events` (`owner_id`);