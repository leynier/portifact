CREATE TABLE `github_trust_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`repository_owner_id` text NOT NULL,
	`repository` text NOT NULL,
	`events` text NOT NULL,
	`ref` text,
	`environment` text,
	`scopes` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_trust_rules_repository_idx` ON `github_trust_rules` (`workspace_id`,`repository_id`);--> statement-breakpoint
CREATE TABLE `github_used_tokens` (
	`jti_hash` text PRIMARY KEY NOT NULL,
	`claim` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `github_used_tokens_expiry_idx` ON `github_used_tokens` (`expires_at`);--> statement-breakpoint
ALTER TABLE `service_tokens` ADD `trust_rule_id` text REFERENCES github_trust_rules(id) ON UPDATE no action ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `service_tokens_rule_idx` ON `service_tokens` (`trust_rule_id`,`expires_at`);