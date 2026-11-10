CREATE TABLE `artifact_groups` (
	`artifact_id` text NOT NULL,
	`group_id` text NOT NULL,
	`comment_visibility` text,
	`created_at` integer NOT NULL,
	`checked_at` integer,
	PRIMARY KEY(`artifact_id`, `group_id`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifact_groups_group_idx` ON `artifact_groups` (`group_id`);--> statement-breakpoint
CREATE INDEX `artifact_groups_checked_idx` ON `artifact_groups` (`checked_at`);--> statement-breakpoint
CREATE TABLE `workspace_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`,`group_id`) REFERENCES `workspace_groups`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`user_id`) REFERENCES `workspace_members`(`workspace_id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_group_members_group_user_idx` ON `workspace_group_members` (`group_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `workspace_group_members_member_idx` ON `workspace_group_members` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `workspace_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_groups_name_length" CHECK(length("workspace_groups"."name") between 1 and 80)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_groups_workspace_id_idx` ON `workspace_groups` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_groups_workspace_name_idx` ON `workspace_groups` (`workspace_id`,lower("name"));