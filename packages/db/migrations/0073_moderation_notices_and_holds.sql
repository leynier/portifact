CREATE TABLE `legal_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`owner_email` text,
	`reason` text NOT NULL,
	`ground` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`release_at` integer,
	`released_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `legal_holds_open_artifact_idx` ON `legal_holds` (`artifact_id`) WHERE "legal_holds"."released_at" is null;--> statement-breakpoint
CREATE INDEX `legal_holds_release_idx` ON `legal_holds` (`released_at`,`release_at`);--> statement-breakpoint
CREATE TABLE `moderation_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`suspension_id` text,
	`report_id` text,
	`source` text NOT NULL,
	`facts` text NOT NULL,
	`ground` text,
	`notice` text NOT NULL,
	`recipients` integer DEFAULT 0 NOT NULL,
	`notified_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `moderation_decisions_target_idx` ON `moderation_decisions` (`target_kind`,`target_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `moderation_decisions_suspension_idx` ON `moderation_decisions` (`suspension_id`);--> statement-breakpoint
CREATE TABLE `moderation_notice_sends` (
	`decision_id` text NOT NULL,
	`user_id` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`decision_id`, `user_id`)
);
--> statement-breakpoint
ALTER TABLE `abuse_reports` ADD `reporter_email_key` text;--> statement-breakpoint
ALTER TABLE `abuse_reports` ADD `reporter_name` text;--> statement-breakpoint
ALTER TABLE `abuse_reports` ADD `address` text;--> statement-breakpoint
ALTER TABLE `abuse_reports` ADD `confirmed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `abuse_reports` ADD `locale` text;--> statement-breakpoint
ALTER TABLE `abuse_reports` ADD `outcome_notice` text;--> statement-breakpoint
ALTER TABLE `abuse_reports` ADD `outcome_notified_at` integer;--> statement-breakpoint
ALTER TABLE `account_deletions` ADD `attempted_at` integer;--> statement-breakpoint
ALTER TABLE `workspace_deletions` ADD `attempted_at` integer;