CREATE TABLE `maintenance_cursors` (
	`name` text PRIMARY KEY NOT NULL,
	`cursor` text DEFAULT '' NOT NULL,
	`pass_started_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_findings` (
	`kind` text NOT NULL,
	`r2_key` text NOT NULL,
	`detail` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `r2_key`)
);
--> statement-breakpoint
ALTER TABLE `outbox` ADD `subject` text;--> statement-breakpoint
ALTER TABLE `outbox` ADD `generation` integer;--> statement-breakpoint
CREATE INDEX `outbox_subject_idx` ON `outbox` (`topic`,`subject`);