CREATE TABLE `review_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`version_id` text NOT NULL,
	`required` integer,
	`show_status` integer DEFAULT false NOT NULL,
	`requested_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`cancelled_at` integer,
	`cancel_reason` text,
	`announced` text,
	`checked_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "review_requests_required" CHECK("review_requests"."required" is null or "review_requests"."required" between 1 and 10),
	CONSTRAINT "review_requests_cancelled" CHECK(("review_requests"."cancelled_at" is null) = ("review_requests"."cancel_reason" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_requests_open_idx` ON `review_requests` (`artifact_id`) WHERE "review_requests"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX `review_requests_artifact_idx` ON `review_requests` (`artifact_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `review_requests_checked_idx` ON `review_requests` (`cancelled_at`,`checked_at`);--> statement-breakpoint
CREATE INDEX `review_requests_requested_by_idx` ON `review_requests` (`requested_by`);--> statement-breakpoint
CREATE TABLE `review_reviewers` (
	`request_id` text NOT NULL,
	`email` text NOT NULL,
	`added_at` integer NOT NULL,
	`dropped_at` integer,
	PRIMARY KEY(`request_id`, `email`),
	FOREIGN KEY (`request_id`) REFERENCES `review_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_reviewers_email_idx` ON `review_reviewers` (`email`);--> statement-breakpoint
CREATE TABLE `review_verdicts` (
	`request_id` text NOT NULL,
	`email` text NOT NULL,
	`version_id` text NOT NULL,
	`author_id` text NOT NULL,
	`verdict` text NOT NULL,
	`note` text,
	`note_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`request_id`, `email`, `version_id`),
	FOREIGN KEY (`request_id`) REFERENCES `review_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "review_verdicts_note_bytes" CHECK("review_verdicts"."note_bytes" between 0 and 4096)
);
--> statement-breakpoint
CREATE INDEX `review_verdicts_author_idx` ON `review_verdicts` (`author_id`);