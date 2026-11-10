CREATE TABLE `service_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`label` text NOT NULL,
	`role` text NOT NULL,
	`scopes` text NOT NULL,
	`restriction` text DEFAULT 'none' NOT NULL,
	`key_prefix` text,
	`token_hash` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "service_tokens_role" CHECK("service_tokens"."role" = 'editor'),
	CONSTRAINT "service_tokens_restriction" CHECK(("service_tokens"."restriction" = 'key') = ("service_tokens"."key_prefix" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_tokens_hash_idx` ON `service_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `service_tokens_workspace_idx` ON `service_tokens` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `artifacts` ADD `external_key` text;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `created_by` text;--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_owner_key_idx` ON `artifacts` (`owner_id`,`external_key`) WHERE "artifacts"."external_key" is not null and "artifacts"."state" not in ('purging', 'deleted');