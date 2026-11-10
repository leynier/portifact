CREATE TABLE `scim_group_members` (
	`group_id` text NOT NULL,
	`scim_user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `scim_user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `scim_groups`(`group_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scim_user_id`) REFERENCES `scim_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scim_group_members_user_idx` ON `scim_group_members` (`scim_user_id`);--> statement-breakpoint
CREATE TABLE `scim_groups` (
	`group_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`external_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`write_id` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `workspace_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scim_groups_workspace_external_idx` ON `scim_groups` (`workspace_id`,`external_id`);--> statement-breakpoint
ALTER TABLE `scim_users` ADD `mapped_role` text;--> statement-breakpoint
ALTER TABLE `workspace_scim` ADD `editor_group_id` text;--> statement-breakpoint
ALTER TABLE `workspace_scim` ADD `admin_group_id` text;