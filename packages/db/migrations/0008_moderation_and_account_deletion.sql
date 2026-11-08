CREATE TABLE `account_deletions` (
	`user_id` text PRIMARY KEY NOT NULL,
	`requested_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `suspensions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`reason` text NOT NULL,
	`previous_state` text,
	`report_id` text,
	`parent_id` text,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`lifted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suspensions_open_target_idx` ON `suspensions` (`kind`,`target_id`) WHERE "suspensions"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX `suspensions_parent_idx` ON `suspensions` (`parent_id`);--> statement-breakpoint
ALTER TABLE `abuse_reports` ADD `resolved_at` integer;--> statement-breakpoint
CREATE INDEX `abuse_reports_artifact_idx` ON `abuse_reports` (`artifact_id`);--> statement-breakpoint
ALTER TABLE `artifacts` ADD `suspension_reason` text;