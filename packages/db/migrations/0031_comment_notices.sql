CREATE TABLE `comment_notice_mutes` (
	`artifact_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`artifact_id`, `user_id`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comment_notice_mutes_user_idx` ON `comment_notice_mutes` (`user_id`);--> statement-breakpoint
CREATE TABLE `comment_notices` (
	`recipient_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`created` integer DEFAULT 0 NOT NULL,
	`replies` integer DEFAULT 0 NOT NULL,
	`resolved` integer DEFAULT 0 NOT NULL,
	`first_at` integer NOT NULL,
	PRIMARY KEY(`recipient_id`, `thread_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `annotation_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "comment_notices_counts" CHECK("comment_notices"."created" in (0, 1) and "comment_notices"."resolved" in (0, 1) and "comment_notices"."replies" between 0 and 200)
);
--> statement-breakpoint
CREATE INDEX `comment_notices_recipient_first_idx` ON `comment_notices` (`recipient_id`,`first_at`);--> statement-breakpoint
CREATE INDEX `comment_notices_first_idx` ON `comment_notices` (`first_at`);--> statement-breakpoint
ALTER TABLE `account_settings` ADD `comment_notices` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `account_settings` ADD `comment_notices_changed_at` integer;