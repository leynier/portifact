CREATE TABLE `scim_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_tokens_hash_idx` ON `scim_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `scim_tokens_workspace_idx` ON `scim_tokens` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `scim_users` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`external_id` text,
	`names` text,
	`active` integer NOT NULL,
	`user_id` text,
	`removed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`write_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_users_workspace_email_idx` ON `scim_users` (`workspace_id`,`email`);--> statement-breakpoint
CREATE INDEX `scim_users_workspace_created_idx` ON `scim_users` (`workspace_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `scim_users_workspace_external_idx` ON `scim_users` (`workspace_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `scim_users_user_idx` ON `scim_users` (`user_id`);--> statement-breakpoint
CREATE TABLE `workspace_scim` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`invitation_emails` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `workspace_invitations` ADD `source` text DEFAULT 'admin' NOT NULL;