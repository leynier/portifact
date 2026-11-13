CREATE TABLE `acceptance_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`origin` text NOT NULL,
	`thread_id` text,
	`user_id` text,
	`digest` text NOT NULL,
	`base_version_id` text NOT NULL,
	`version_id` text,
	`state` text DEFAULT 'running' NOT NULL,
	`reason` text,
	`deliveries` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `annotation_threads`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "acceptance_attempts_digest" CHECK(length("acceptance_attempts"."digest") = 64 and "acceptance_attempts"."digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "acceptance_attempts_reason" CHECK(("acceptance_attempts"."state" = 'ended') = ("acceptance_attempts"."reason" is not null)),
	CONSTRAINT "acceptance_attempts_deliveries" CHECK("acceptance_attempts"."deliveries" >= 0)
);
--> statement-breakpoint
CREATE INDEX `acceptance_attempts_state_updated_idx` ON `acceptance_attempts` (`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `acceptance_attempts_artifact_idx` ON `acceptance_attempts` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `acceptance_attempts_thread_idx` ON `acceptance_attempts` (`thread_id`) WHERE "acceptance_attempts"."thread_id" is not null;--> statement-breakpoint
CREATE INDEX `acceptance_attempts_user_idx` ON `acceptance_attempts` (`user_id`) WHERE "acceptance_attempts"."user_id" is not null;--> statement-breakpoint
CREATE TABLE `acceptance_claims` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`run_token` text NOT NULL,
	`artifact_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `acceptance_attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `acceptance_claims_created_idx` ON `acceptance_claims` (`created_at`);--> statement-breakpoint
CREATE TABLE `change_items` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`origin` text NOT NULL,
	`thread_id` text,
	`attempt_id` text,
	`version_id` text NOT NULL,
	`path` text NOT NULL,
	`route` text,
	`envelope` text NOT NULL,
	`proof` text,
	`bytes` integer NOT NULL,
	`reason` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`created_by` text,
	`submitted_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`closed_at` integer,
	`closed_by` text,
	`closed_version_id` text,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `annotation_threads`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "change_items_origin" CHECK("change_items"."origin" in ('suggestion', 'draft')),
	CONSTRAINT "change_items_state" CHECK("change_items"."state" in ('open', 'applied', 'dismissed', 'closed_by_version')),
	CONSTRAINT "change_items_bytes" CHECK("change_items"."bytes" = length(cast("change_items"."envelope" as blob)) + coalesce(length(cast("change_items"."proof" as blob)), 0) and length(cast("change_items"."envelope" as blob)) between 2 and 16384 and coalesce(length(cast("change_items"."proof" as blob)), 0) <= 16384),
	CONSTRAINT "change_items_reason" CHECK(length("change_items"."reason") between 1 and 64 and "change_items"."reason" not glob '*[^a-z0-9_]*'),
	CONSTRAINT "change_items_draft_thread" CHECK("change_items"."origin" = 'suggestion' or "change_items"."thread_id" is null),
	CONSTRAINT "change_items_closing" CHECK(case "change_items"."state"
        when 'open' then "change_items"."closed_at" is null and "change_items"."closed_by" is null and "change_items"."closed_version_id" is null
        when 'closed_by_version' then "change_items"."closed_at" is not null and "change_items"."closed_by" is null and "change_items"."closed_version_id" is not null
        else "change_items"."closed_at" is not null and "change_items"."closed_version_id" is null end),
	CONSTRAINT "change_items_revision" CHECK("change_items"."revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX `change_items_artifact_state_idx` ON `change_items` (`artifact_id`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `change_items_thread_idx` ON `change_items` (`thread_id`) WHERE "change_items"."thread_id" is not null;--> statement-breakpoint
CREATE INDEX `change_items_closed_idx` ON `change_items` (`closed_at`) WHERE "change_items"."closed_at" is not null;--> statement-breakpoint
CREATE INDEX `change_items_created_by_idx` ON `change_items` (`created_by`) WHERE "change_items"."created_by" is not null;--> statement-breakpoint
CREATE INDEX `change_items_closed_by_idx` ON `change_items` (`closed_by`) WHERE "change_items"."closed_by" is not null;--> statement-breakpoint
CREATE INDEX `change_items_submitted_by_idx` ON `change_items` (`submitted_by`) WHERE "change_items"."submitted_by" is not null;--> statement-breakpoint
CREATE TABLE `edit_drafts` (
	`artifact_id` text NOT NULL,
	`user_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`base_version_id` text NOT NULL,
	`edit` text NOT NULL,
	`edit_bytes` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`attempt_id` text,
	`attempt_reason` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`artifact_id`, `user_id`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "edit_drafts_bytes" CHECK("edit_drafts"."edit_bytes" = length(cast("edit_drafts"."edit" as blob)) and "edit_drafts"."edit_bytes" between 2 and 131072),
	CONSTRAINT "edit_drafts_revision" CHECK("edit_drafts"."revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX `edit_drafts_user_idx` ON `edit_drafts` (`user_id`);--> statement-breakpoint
CREATE INDEX `edit_drafts_updated_idx` ON `edit_drafts` (`updated_at`);--> statement-breakpoint
CREATE TABLE `preview_codes` (
	`code_sha256` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`thread_id` text,
	`r2_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`redeemed_at` integer,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `annotation_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "preview_codes_code" CHECK(length("preview_codes"."code_sha256") = 64 and "preview_codes"."code_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "preview_codes_key" CHECK("preview_codes"."r2_key" like 'previews/%'),
	CONSTRAINT "preview_codes_expiry" CHECK("preview_codes"."expires_at" > "preview_codes"."created_at")
);
--> statement-breakpoint
CREATE INDEX `preview_codes_user_idx` ON `preview_codes` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `preview_codes_expires_idx` ON `preview_codes` (`expires_at`);--> statement-breakpoint
CREATE INDEX `preview_codes_artifact_idx` ON `preview_codes` (`artifact_id`);--> statement-breakpoint
CREATE TABLE `suggestion_plans` (
	`user_id` text NOT NULL,
	`digest` text NOT NULL,
	`artifact_id` text NOT NULL,
	`thread_id` text,
	`plan` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `digest`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `annotation_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "suggestion_plans_digest" CHECK(length("suggestion_plans"."digest") = 64 and "suggestion_plans"."digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "suggestion_plans_bytes" CHECK(length(cast("suggestion_plans"."plan" as blob)) <= 524288)
);
--> statement-breakpoint
CREATE INDEX `suggestion_plans_expires_idx` ON `suggestion_plans` (`expires_at`);--> statement-breakpoint
CREATE INDEX `suggestion_plans_artifact_idx` ON `suggestion_plans` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `suggestion_plans_thread_idx` ON `suggestion_plans` (`thread_id`) WHERE "suggestion_plans"."thread_id" is not null;--> statement-breakpoint
ALTER TABLE `annotation_threads` ADD `kind` text DEFAULT 'comment' NOT NULL;--> statement-breakpoint
ALTER TABLE `annotation_threads` ADD `suggestion_state` text;--> statement-breakpoint
ALTER TABLE `annotation_threads` ADD `edit` text;--> statement-breakpoint
ALTER TABLE `annotation_threads` ADD `edit_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `annotation_threads` ADD `edit_proofs` text;--> statement-breakpoint
ALTER TABLE `annotation_threads` ADD `suggestion_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `annotation_threads` ADD `attempt_id` text;--> statement-breakpoint
ALTER TABLE `annotation_threads` ADD `attempt_reason` text;--> statement-breakpoint
ALTER TABLE `annotation_threads` ADD `decided_by` text;--> statement-breakpoint
ALTER TABLE `annotation_threads` ADD `decided_at` integer;--> statement-breakpoint
ALTER TABLE `annotation_threads` ADD `result_version_id` text;--> statement-breakpoint
ALTER TABLE `annotation_threads` ADD `origin_version_id` text;--> statement-breakpoint
ALTER TABLE `annotation_threads` ADD `origin_target` text;--> statement-breakpoint
CREATE INDEX `annotation_threads_artifact_suggestion_idx` ON `annotation_threads` (`artifact_id`,`suggestion_state`) WHERE "annotation_threads"."kind" = 'suggestion';--> statement-breakpoint
CREATE INDEX `annotation_threads_decided_by_idx` ON `annotation_threads` (`decided_by`) WHERE "annotation_threads"."decided_by" is not null;