CREATE TABLE `artifact_data` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`documents_bytes` integer DEFAULT 0 NOT NULL,
	`report_generation` integer DEFAULT 0 NOT NULL,
	`report_seq` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `data_findings` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
