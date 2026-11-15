CREATE TABLE `comment_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`thread_id` text,
	`message_id` text,
	`uploaded_by` text NOT NULL,
	`name` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`content_type` text,
	`state` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer,
	`attached_at` integer,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `annotation_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `annotation_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "comment_attachments_size" CHECK("comment_attachments"."size" between 1 and 10485760),
	CONSTRAINT "comment_attachments_sha256" CHECK(length("comment_attachments"."sha256") = 64),
	CONSTRAINT "comment_attachments_type" CHECK("comment_attachments"."content_type" is null or "comment_attachments"."content_type" in ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain')),
	CONSTRAINT "comment_attachments_state" CHECK(("comment_attachments"."state" = 'pending' and "comment_attachments"."thread_id" is null and "comment_attachments"."message_id" is null and "comment_attachments"."content_type" is null and "comment_attachments"."expires_at" is not null and "comment_attachments"."attached_at" is null) or ("comment_attachments"."state" = 'attached' and "comment_attachments"."thread_id" is not null and "comment_attachments"."message_id" is not null and "comment_attachments"."content_type" is not null and "comment_attachments"."expires_at" is null and "comment_attachments"."attached_at" is not null))
);
--> statement-breakpoint
CREATE INDEX `comment_attachments_message_idx` ON `comment_attachments` (`message_id`);--> statement-breakpoint
CREATE INDEX `comment_attachments_thread_idx` ON `comment_attachments` (`thread_id`);--> statement-breakpoint
CREATE INDEX `comment_attachments_artifact_idx` ON `comment_attachments` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `comment_attachments_uploader_idx` ON `comment_attachments` (`uploaded_by`,`expires_at`) WHERE "comment_attachments"."state" = 'pending';--> statement-breakpoint
CREATE INDEX `comment_attachments_pending_idx` ON `comment_attachments` (`expires_at`) WHERE "comment_attachments"."state" = 'pending';