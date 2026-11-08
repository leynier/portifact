CREATE TABLE `annotation_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`artifact_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`message_id` text,
	`actor_id` text NOT NULL,
	`write_id` text NOT NULL,
	`kind` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `annotation_events_write_idx` ON `annotation_events` (`write_id`);--> statement-breakpoint
CREATE INDEX `annotation_events_artifact_id_idx` ON `annotation_events` (`artifact_id`,`id`);--> statement-breakpoint
CREATE INDEX `annotation_events_actor_at_idx` ON `annotation_events` (`actor_id`,`at`);--> statement-breakpoint
CREATE INDEX `annotation_events_artifact_at_idx` ON `annotation_events` (`artifact_id`,`at`);--> statement-breakpoint
CREATE TABLE `annotation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text,
	`body_bytes` integer NOT NULL,
	`state` text DEFAULT 'visible' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`edited_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `annotation_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "annotation_messages_body_bytes" CHECK("annotation_messages"."body_bytes" between 0 and 8192),
	CONSTRAINT "annotation_messages_deleted_body" CHECK(("annotation_messages"."state" = 'deleted') = ("annotation_messages"."body" is null))
);
--> statement-breakpoint
CREATE INDEX `annotation_messages_thread_created_idx` ON `annotation_messages` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `annotation_messages_author_idx` ON `annotation_messages` (`author_id`);--> statement-breakpoint
CREATE TABLE `annotation_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`version_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`author_id` text NOT NULL,
	`target` text NOT NULL,
	`target_bytes` integer NOT NULL,
	`path` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`change_seq` integer DEFAULT 0 NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "annotation_threads_target_bytes" CHECK("annotation_threads"."target_bytes" between 1 and 8192),
	CONSTRAINT "annotation_threads_counters" CHECK("annotation_threads"."message_count" >= 0 and "annotation_threads"."message_count" <= 200 and "annotation_threads"."revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX `annotation_threads_artifact_version_state_idx` ON `annotation_threads` (`artifact_id`,`version_id`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `annotation_threads_artifact_change_idx` ON `annotation_threads` (`artifact_id`,`change_seq`);--> statement-breakpoint
CREATE INDEX `annotation_threads_author_idx` ON `annotation_threads` (`author_id`);--> statement-breakpoint
CREATE TABLE `annotation_usage` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`messages` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "annotation_usage_nonnegative" CHECK("annotation_usage"."messages" >= 0 and "annotation_usage"."bytes" >= 0),
	CONSTRAINT "annotation_usage_messages_limit" CHECK("annotation_usage"."messages" <= 5000),
	CONSTRAINT "annotation_usage_bytes_limit" CHECK("annotation_usage"."bytes" <= 50000000)
);
