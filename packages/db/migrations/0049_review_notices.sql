CREATE TABLE `review_notices` (
	`artifact_id` text NOT NULL,
	`version_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`kind` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`artifact_id`, `version_id`, `recipient_id`, `kind`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_notices_recipient_idx` ON `review_notices` (`recipient_id`);--> statement-breakpoint
CREATE INDEX `review_notices_version_idx` ON `review_notices` (`version_id`);