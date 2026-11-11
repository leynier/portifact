CREATE TABLE `audit_stream_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stream_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`at` integer NOT NULL,
	`outcome` text NOT NULL,
	`source` text,
	`events` integer DEFAULT 0 NOT NULL,
	`status_class` text,
	`error` text,
	FOREIGN KEY (`stream_id`) REFERENCES `audit_streams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_stream_deliveries_stream_idx` ON `audit_stream_deliveries` (`stream_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_stream_deliveries_at_idx` ON `audit_stream_deliveries` (`at`);--> statement-breakpoint
CREATE TABLE `audit_streams` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`label` text NOT NULL,
	`host` text NOT NULL,
	`key_id` text NOT NULL,
	`url_box` text NOT NULL,
	`secret_box` text NOT NULL,
	`previous_secret_box` text,
	`previous_until` integer,
	`state` text NOT NULL,
	`paused_reason` text,
	`paused_at` integer,
	`regional_at` integer,
	`regional_id` text DEFAULT '' NOT NULL,
	`global_at` integer,
	`global_id` text DEFAULT '' NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`failing_since` integer,
	`next_attempt_at` integer,
	`gap_source` text,
	`gap_from` integer,
	`gap_to` integer,
	`test_requested_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_by` text,
	CONSTRAINT "audit_streams_failures" CHECK("audit_streams"."failures" >= 0)
);
--> statement-breakpoint
CREATE INDEX `audit_streams_owner_idx` ON `audit_streams` (`owner_id`);