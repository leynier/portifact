CREATE TABLE `share_handoffs` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`session_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`link_id`) REFERENCES `share_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_handoffs_expires_idx` ON `share_handoffs` (`expires_at`);--> statement-breakpoint
CREATE TABLE `share_links` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text NOT NULL,
	`expires_at` integer,
	`password_hash` text,
	`password_salt` text,
	`password_iterations` integer,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`revoked_at` integer,
	`last_used_at` integer,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "share_links_password_complete" CHECK(("share_links"."password_hash" is null) = ("share_links"."password_salt" is null) and ("share_links"."password_hash" is null) = ("share_links"."password_iterations" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_links_token_idx` ON `share_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `share_links_artifact_idx` ON `share_links` (`artifact_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `share_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`link_id`) REFERENCES `share_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_sessions_expires_idx` ON `share_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `share_sessions_link_idx` ON `share_sessions` (`link_id`);