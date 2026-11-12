PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_change_items` (
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
	CONSTRAINT "change_items_origin" CHECK("__new_change_items"."origin" in ('suggestion', 'draft')),
	CONSTRAINT "change_items_state" CHECK("__new_change_items"."state" in ('open', 'applied', 'dismissed', 'closed_by_version')),
	CONSTRAINT "change_items_bytes" CHECK("__new_change_items"."bytes" = length(cast("__new_change_items"."envelope" as blob)) + coalesce(length(cast("__new_change_items"."proof" as blob)), 0) and length(cast("__new_change_items"."envelope" as blob)) between 2 and 16384 and coalesce(length(cast("__new_change_items"."proof" as blob)), 0) <= 16384),
	CONSTRAINT "change_items_reason" CHECK(length("__new_change_items"."reason") between 1 and 64 and "__new_change_items"."reason" not glob '*[^a-z0-9_]*'),
	CONSTRAINT "change_items_draft_thread" CHECK("__new_change_items"."origin" = 'suggestion' or "__new_change_items"."thread_id" is null),
	CONSTRAINT "change_items_closing" CHECK(case "__new_change_items"."state"
        when 'open' then "__new_change_items"."closed_at" is null and "__new_change_items"."closed_by" is null and "__new_change_items"."closed_version_id" is null
        when 'closed_by_version' then "__new_change_items"."closed_at" is not null and "__new_change_items"."closed_by" is null and "__new_change_items"."closed_version_id" is not null
        else "__new_change_items"."closed_at" is not null and "__new_change_items"."closed_version_id" is null end),
	CONSTRAINT "change_items_revision" CHECK("__new_change_items"."revision" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_change_items`("id", "artifact_id", "owner_id", "origin", "thread_id", "attempt_id", "version_id", "path", "route", "envelope", "proof", "bytes", "reason", "state", "created_by", "submitted_by", "created_at", "closed_at", "closed_by", "closed_version_id", "revision") SELECT "id", "artifact_id", "owner_id", "origin", "thread_id", "attempt_id", "version_id", "path", "route", "envelope", "proof", "bytes", "reason", "state", "created_by", "submitted_by", "created_at", "closed_at", "closed_by", "closed_version_id", "revision" FROM `change_items`;--> statement-breakpoint
DROP TABLE `change_items`;--> statement-breakpoint
ALTER TABLE `__new_change_items` RENAME TO `change_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `change_items_artifact_state_idx` ON `change_items` (`artifact_id`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `change_items_thread_idx` ON `change_items` (`thread_id`) WHERE "change_items"."thread_id" is not null;--> statement-breakpoint
CREATE INDEX `change_items_closed_idx` ON `change_items` (`closed_at`) WHERE "change_items"."closed_at" is not null;--> statement-breakpoint
CREATE INDEX `change_items_created_by_idx` ON `change_items` (`created_by`) WHERE "change_items"."created_by" is not null;--> statement-breakpoint
CREATE INDEX `change_items_closed_by_idx` ON `change_items` (`closed_by`) WHERE "change_items"."closed_by" is not null;--> statement-breakpoint
CREATE INDEX `change_items_submitted_by_idx` ON `change_items` (`submitted_by`) WHERE "change_items"."submitted_by" is not null;