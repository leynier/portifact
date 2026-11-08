CREATE TABLE `access_events` (
	`artifact_id` text NOT NULL,
	`window_start` integer NOT NULL,
	`user_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`email` text NOT NULL,
	`opened_at` integer NOT NULL,
	PRIMARY KEY(`artifact_id`, `window_start`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `access_events_user_idx` ON `access_events` (`user_id`);--> statement-breakpoint
CREATE INDEX `access_events_opened_idx` ON `access_events` (`opened_at`);