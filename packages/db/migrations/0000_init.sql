CREATE TABLE `abuse_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`reporter_email` text,
	`reason` text NOT NULL,
	`details` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `abuse_reports_status_idx` ON `abuse_reports` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `account_usage` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`active_artifacts` integer DEFAULT 0 NOT NULL,
	`stored_bytes` integer DEFAULT 0 NOT NULL,
	`reserved_bytes` integer DEFAULT 0 NOT NULL,
	`open_uploads` integer DEFAULT 0 NOT NULL,
	`new_objects_this_month` integer DEFAULT 0 NOT NULL,
	`month_started_at` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "account_usage_nonnegative" CHECK("account_usage"."active_artifacts" >= 0 and "account_usage"."stored_bytes" >= 0 and "account_usage"."reserved_bytes" >= 0 and "account_usage"."open_uploads" >= 0),
	CONSTRAINT "account_usage_active_limit" CHECK("account_usage"."active_artifacts" <= 50),
	CONSTRAINT "account_usage_bytes_limit" CHECK("account_usage"."stored_bytes" + "account_usage"."reserved_bytes" <= 2500000000)
);
--> statement-breakpoint
CREATE TABLE `artifact_readers` (
	`artifact_id` text NOT NULL,
	`email` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`artifact_id`, `email`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "artifact_readers_email_lower" CHECK("artifact_readers"."email" = lower("artifact_readers"."email"))
);
--> statement-breakpoint
CREATE INDEX `artifact_readers_email_idx` ON `artifact_readers` (`email`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`access_mode` text DEFAULT 'restricted' NOT NULL,
	`policy_generation` integer DEFAULT 1 NOT NULL,
	`annotations` text DEFAULT 'off' NOT NULL,
	`indexable` integer DEFAULT false NOT NULL,
	`embeddable` integer DEFAULT false NOT NULL,
	`current_version_id` text,
	`lifecycle_generation` integer DEFAULT 1 NOT NULL,
	`expires_at` integer,
	`archived_at` integer,
	`purge_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "artifacts_id_format" CHECK(length("artifacts"."id") = 10),
	CONSTRAINT "artifacts_name_length" CHECK(length("artifacts"."name") between 1 and 200)
);
--> statement-breakpoint
CREATE INDEX `artifacts_owner_state_idx` ON `artifacts` (`owner_id`,`state`);--> statement-breakpoint
CREATE INDEX `artifacts_state_expires_idx` ON `artifacts` (`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `artifacts_state_purge_idx` ON `artifacts` (`state`,`purge_at`);--> statement-breakpoint
CREATE TABLE `lifecycle_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`artifact_id` text NOT NULL,
	`actor_id` text,
	`channel` text NOT NULL,
	`event` text NOT NULL,
	`details` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lifecycle_events_artifact_at_idx` ON `lifecycle_events` (`artifact_id`,`at`);--> statement-breakpoint
CREATE TABLE `objects` (
	`owner_id` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`r2_key` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`owner_id`, `sha256`),
	CONSTRAINT "objects_sha256_format" CHECK(length("objects"."sha256") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `objects_r2_key_idx` ON `objects` (`r2_key`);--> statement-breakpoint
CREATE TABLE `operations` (
	`actor_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`operation` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` integer,
	`result` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`actor_id`, `idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic` text NOT NULL,
	`payload` text NOT NULL,
	`available_at` integer NOT NULL,
	`dispatched_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`dispatched_at`,`available_at`);--> statement-breakpoint
CREATE TABLE `tombstones` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`deleted_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `id`)
);
--> statement-breakpoint
CREATE TABLE `upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`version_id` text NOT NULL,
	`base_version_id` text,
	`state` text DEFAULT 'uploading' NOT NULL,
	`reserved_slots` integer DEFAULT 0 NOT NULL,
	`reserved_bytes` integer DEFAULT 0 NOT NULL,
	`reserved_files` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `upload_sessions_owner_state_idx` ON `upload_sessions` (`owner_id`,`state`);--> statement-breakpoint
CREATE INDEX `upload_sessions_state_expires_idx` ON `upload_sessions` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_events_owner_kind_at_idx` ON `usage_events` (`owner_id`,`kind`,`at`);--> statement-breakpoint
CREATE TABLE `version_files` (
	`version_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`owner_id` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`content_type` text NOT NULL,
	PRIMARY KEY(`version_id`, `kind`, `path`),
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `version_files_object_idx` ON `version_files` (`owner_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `versions` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`number` integer NOT NULL,
	`author_id` text NOT NULL,
	`state` text DEFAULT 'uploading' NOT NULL,
	`entrypoint` text NOT NULL,
	`published_bytes` integer NOT NULL,
	`source_bytes` integer DEFAULT 0 NOT NULL,
	`renderer_version` text,
	`committed_at` integer,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "versions_bytes_nonnegative" CHECK("versions"."published_bytes" >= 0 and "versions"."source_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `versions_artifact_number_idx` ON `versions` (`artifact_id`,`number`);--> statement-breakpoint
CREATE INDEX `versions_state_expires_idx` ON `versions` (`state`,`expires_at`);