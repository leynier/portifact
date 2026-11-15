CREATE TABLE `journal_deletions` (
	`key` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`entry` text NOT NULL,
	`claim` text NOT NULL,
	`claimed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `journal_deletions_claimed_idx` ON `journal_deletions` (`claimed_at`);