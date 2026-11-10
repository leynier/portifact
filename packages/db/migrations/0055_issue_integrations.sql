CREATE TABLE `integration_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`service` text NOT NULL,
	`label` text NOT NULL,
	`key_id` text NOT NULL,
	`credential_box` text NOT NULL,
	`credential_hint` text NOT NULL,
	`identity` text NOT NULL,
	`targets` text NOT NULL,
	`attention` text,
	`attention_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT "integration_connections_revision" CHECK("integration_connections"."revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX `integration_connections_owner_idx` ON `integration_connections` (`owner_id`);--> statement-breakpoint
CREATE TABLE `thread_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`service` text NOT NULL,
	`target` text NOT NULL,
	`target_name` text NOT NULL,
	`requested_by` text,
	`idempotency_key` text NOT NULL,
	`write_id` text NOT NULL,
	`include_link` integer NOT NULL,
	`include_name` integer NOT NULL,
	`include_quote` integer NOT NULL,
	`include_message` integer NOT NULL,
	`title` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`failure` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`issue_key` text,
	`issue_url` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `annotation_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "thread_issues_attempts" CHECK("thread_issues"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_issues_request_idx` ON `thread_issues` (`requested_by`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `thread_issues_write_idx` ON `thread_issues` (`write_id`);--> statement-breakpoint
CREATE INDEX `thread_issues_thread_idx` ON `thread_issues` (`thread_id`);--> statement-breakpoint
CREATE INDEX `thread_issues_connection_idx` ON `thread_issues` (`connection_id`,`state`);