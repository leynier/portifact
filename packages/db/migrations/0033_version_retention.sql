-- Previous versions are kept by the owner's plan (premium plan P3): the time a version stopped
-- being current replaces its fixed expiry, and retention is decided from it when read or pruned.
-- Existing previous versions were given seven days from that moment, so it is their expiry less
-- seven days.
ALTER TABLE `versions` ADD `superseded_at` integer;--> statement-breakpoint
UPDATE `versions` SET `superseded_at` = `expires_at` - 604800000 WHERE `expires_at` IS NOT NULL;--> statement-breakpoint
DROP INDEX `versions_state_expires_idx`;--> statement-breakpoint
ALTER TABLE `versions` DROP COLUMN `expires_at`;--> statement-breakpoint
CREATE INDEX `versions_superseded_idx` ON `versions` (`superseded_at`) WHERE "versions"."superseded_at" is not null;
