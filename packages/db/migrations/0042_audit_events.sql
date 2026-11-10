CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`target_id` text,
	`artifact_id` text,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_owner_at_idx` ON `audit_events` (`owner_id`,`at`,`id`);--> statement-breakpoint
CREATE INDEX `audit_events_at_idx` ON `audit_events` (`at`);