PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_data_anonymous_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`visitor_id` text NOT NULL,
	`host` text NOT NULL,
	`code_hash` text,
	`nonce_hash` text,
	`code_expires_at` integer NOT NULL,
	`used_at` integer,
	`expires_at` integer NOT NULL,
	`terms_version` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_data_anonymous_grants`("id", "artifact_id", "visitor_id", "host", "code_hash", "nonce_hash", "code_expires_at", "used_at", "expires_at", "terms_version", "created_at") SELECT "id", "artifact_id", "visitor_id", "host", "code_hash", "nonce_hash", "code_expires_at", "used_at", "expires_at", NULL, "created_at" FROM `data_anonymous_grants`;--> statement-breakpoint
DROP TABLE `data_anonymous_grants`;--> statement-breakpoint
ALTER TABLE `__new_data_anonymous_grants` RENAME TO `data_anonymous_grants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `data_anonymous_grants_code_idx` ON `data_anonymous_grants` (`code_hash`);--> statement-breakpoint
CREATE INDEX `data_anonymous_grants_artifact_idx` ON `data_anonymous_grants` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `data_anonymous_grants_expires_idx` ON `data_anonymous_grants` (`expires_at`);--> statement-breakpoint
CREATE INDEX `data_anonymous_grants_unused_idx` ON `data_anonymous_grants` (`code_expires_at`) WHERE "data_anonymous_grants"."used_at" is null;