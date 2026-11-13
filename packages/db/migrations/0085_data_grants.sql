CREATE TABLE `data_grant_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`nonce_hash` text NOT NULL,
	`host` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `data_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `data_grant_codes_expires_idx` ON `data_grant_codes` (`expires_at`);--> statement-breakpoint
CREATE INDEX `data_grant_codes_grant_idx` ON `data_grant_codes` (`grant_id`);--> statement-breakpoint
CREATE TABLE `data_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`user_id` text NOT NULL,
	`visitor_id` text NOT NULL,
	`auth_session_id` text NOT NULL,
	`host` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`redeemed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `data_grants_user_artifact_idx` ON `data_grants` (`user_id`,`artifact_id`);--> statement-breakpoint
CREATE INDEX `data_grants_artifact_idx` ON `data_grants` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `data_grants_expires_idx` ON `data_grants` (`expires_at`);--> statement-breakpoint
CREATE INDEX `data_grants_revoked_idx` ON `data_grants` (`revoked_at`) WHERE "data_grants"."revoked_at" is not null;--> statement-breakpoint
CREATE INDEX `data_grants_unredeemed_idx` ON `data_grants` (`created_at`) WHERE "data_grants"."redeemed_at" is null;