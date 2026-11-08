CREATE TABLE `email_counters` (
	`day` integer PRIMARY KEY NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "email_counters_nonnegative" CHECK("email_counters"."sent" >= 0)
);
--> statement-breakpoint
CREATE TABLE `email_suppressions` (
	`email_hash` text PRIMARY KEY NOT NULL,
	`hint` text NOT NULL,
	`reason` text NOT NULL,
	`event_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_suppressions_expires_idx` ON `email_suppressions` (`expires_at`);