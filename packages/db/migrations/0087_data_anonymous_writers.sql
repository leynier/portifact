CREATE TABLE `data_anonymous_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`visitor_id` text NOT NULL,
	`host` text NOT NULL,
	`code_hash` text NOT NULL,
	`nonce_hash` text NOT NULL,
	`code_expires_at` integer NOT NULL,
	`used_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `data_anonymous_grants_code_idx` ON `data_anonymous_grants` (`code_hash`);--> statement-breakpoint
CREATE INDEX `data_anonymous_grants_artifact_idx` ON `data_anonymous_grants` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `data_anonymous_grants_expires_idx` ON `data_anonymous_grants` (`expires_at`);--> statement-breakpoint
CREATE INDEX `data_anonymous_grants_unused_idx` ON `data_anonymous_grants` (`code_expires_at`) WHERE "data_anonymous_grants"."used_at" is null;--> statement-breakpoint
ALTER TABLE `artifact_data` ADD `writers` text DEFAULT 'signed_in' NOT NULL;