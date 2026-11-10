-- Spike S1 only: the tables Better Auth 1.7.18's organization, SSO and SCIM plugins need, applied
-- after the real migrations of packages/db. Never applied to any deployed database.
ALTER TABLE `sessions` ADD `active_organization_id` text;
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`created_at` integer NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `members_organization_id_idx` ON `members` (`organization_id`);
--> statement-breakpoint
CREATE INDEX `members_user_id_idx` ON `members` (`user_id`);
--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`inviter_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invitations_organization_id_idx` ON `invitations` (`organization_id`);
--> statement-breakpoint
CREATE INDEX `invitations_email_idx` ON `invitations` (`email`);
--> statement-breakpoint
CREATE TABLE `sso_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`oidc_config` text,
	`saml_config` text,
	`user_id` text,
	`provider_id` text NOT NULL,
	`organization_id` text,
	`domain` text NOT NULL,
	`domain_verified` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sso_providers_provider_id_unique` ON `sso_providers` (`provider_id`);
--> statement-breakpoint
CREATE TABLE `scim_connection_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`connection_key` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`decommissioned_at` integer,
	`decommission_status` text DEFAULT 'active' NOT NULL,
	`decommission_cursor_user_id` text,
	`decommission_reconciled_user_count` integer DEFAULT 0 NOT NULL,
	`decommission_batch_count` integer DEFAULT 0 NOT NULL,
	`decommission_revision` integer DEFAULT 0 NOT NULL,
	`decommission_completed_at` integer,
	`decommission_lease_id` text,
	`decommission_lease_expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_connection_bindings_connection_key_unique` ON `scim_connection_bindings` (`connection_key`);
--> statement-breakpoint
CREATE TABLE `scim_identity_tombstones` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`external_id` text NOT NULL,
	`external_id_key` text NOT NULL,
	`user_id` text NOT NULL,
	`profile` text NOT NULL,
	`deleted_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_identity_tombstones_external_id_key_unique` ON `scim_identity_tombstones` (`external_id_key`);
--> statement-breakpoint
CREATE TABLE `scim_subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_source_id` text,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_subjects_user_id_unique` ON `scim_subjects` (`user_id`);
--> statement-breakpoint
CREATE TABLE `scim_users` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`user_id` text NOT NULL,
	`connection_user_key` text NOT NULL,
	`user_name` text NOT NULL,
	`user_name_key` text NOT NULL,
	`primary_email` text NOT NULL,
	`work_email_value_index` text NOT NULL,
	`email_value_index` text NOT NULL,
	`display_name` text NOT NULL,
	`formatted_name` text NOT NULL,
	`given_name` text,
	`family_name` text,
	`serialized_emails` text NOT NULL,
	`serialized_attributes` text,
	`external_id` text,
	`external_id_key` text,
	`active` integer NOT NULL,
	`order_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_users_connection_user_key_unique` ON `scim_users` (`connection_user_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_users_user_name_key_unique` ON `scim_users` (`user_name_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_users_external_id_key_unique` ON `scim_users` (`external_id_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_users_order_key_unique` ON `scim_users` (`order_key`);
--> statement-breakpoint
CREATE TABLE `scim_projection_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`scim_user_id` text NOT NULL,
	`user_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_value` text,
	`role` text NOT NULL,
	`grant_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scim_user_id`) REFERENCES `scim_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_projection_grants_grant_key_unique` ON `scim_projection_grants` (`grant_key`);
--> statement-breakpoint
CREATE TABLE `scim_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`display_name` text NOT NULL,
	`display_name_key` text NOT NULL,
	`external_id` text,
	`external_id_key` text,
	`order_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_groups_display_name_key_unique` ON `scim_groups` (`display_name_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_groups_external_id_key_unique` ON `scim_groups` (`external_id_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_groups_order_key_unique` ON `scim_groups` (`order_key`);
--> statement-breakpoint
CREATE TABLE `scim_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`group_id` text NOT NULL,
	`scim_user_id` text NOT NULL,
	`membership_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `scim_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scim_user_id`) REFERENCES `scim_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_group_members_membership_key_unique` ON `scim_group_members` (`membership_key`);
--> statement-breakpoint
-- Test-only fault injection: the first member of a workspace named "Spike fault" fails, to show
-- whether the plugin's multi-row writes are atomic on D1.
CREATE TRIGGER `spike_fail_member_insert` BEFORE INSERT ON `members`
WHEN (SELECT `name` FROM `organizations` WHERE `id` = NEW.`organization_id`) = 'Spike fault'
BEGIN
	SELECT RAISE(ABORT, 'spike fault injection');
END;
--> statement-breakpoint
-- The alternative: Portifact-owned workspace tables, with one role per member, a CHECK on it and
-- a composite primary key, so a concurrent add cannot duplicate a membership.
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);
--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY (`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_members_role` CHECK (`role` IN ('admin', 'editor', 'member'))
);
--> statement-breakpoint
CREATE INDEX `workspace_members_user_id_idx` ON `workspace_members` (`user_id`);
--> statement-breakpoint
CREATE TRIGGER `spike_fail_workspace_member_insert` BEFORE INSERT ON `workspace_members`
WHEN (SELECT `name` FROM `workspaces` WHERE `id` = NEW.`workspace_id`) = 'Spike fault'
BEGIN
	SELECT RAISE(ABORT, 'spike fault injection');
END;
