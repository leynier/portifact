CREATE TABLE `artifact_directory` (
	`id` text PRIMARY KEY NOT NULL,
	`region` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_members_role" CHECK("workspace_members"."role" in ('admin', 'editor', 'member'))
);
--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`region` text DEFAULT 'default' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_idx` ON `workspaces` (`slug`);--> statement-breakpoint
-- A workspace's region is chosen when it is created and never changes (decision 0005): moving
-- data between regions is an export and an import, never an update.
CREATE TRIGGER `workspaces_region_fixed`
BEFORE UPDATE OF `region` ON `workspaces`
WHEN NEW.`region` IS NOT OLD.`region`
BEGIN
  SELECT RAISE(ABORT, 'workspace_region_fixed');
END;
--> statement-breakpoint
-- Every artifact ID ever handed out stays in the directory with its region, so no ID is reused
-- in any region and the content Worker can cache an answer forever (decision 0005, section 2).
CREATE TRIGGER `artifact_directory_refuse_update`
BEFORE UPDATE ON `artifact_directory`
BEGIN
  SELECT RAISE(ABORT, 'artifact_directory_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `artifact_directory_refuse_delete`
BEFORE DELETE ON `artifact_directory`
BEGIN
  SELECT RAISE(ABORT, 'artifact_directory_immutable');
END;
--> statement-breakpoint
-- Every existing artifact is in the default region, the only one there is.
INSERT INTO `artifact_directory` (`id`, `region`, `created_at`)
SELECT `id`, 'default', `created_at` FROM `artifacts` WHERE true
ON CONFLICT (`id`) DO NOTHING;
--> statement-breakpoint
-- Purged artifacts have no row left, only their tombstone; their IDs were handed out too.
INSERT INTO `artifact_directory` (`id`, `region`, `created_at`)
SELECT `id`, 'default', `deleted_at` FROM `tombstones` WHERE `kind` = 'artifact'
ON CONFLICT (`id`) DO NOTHING;
--> statement-breakpoint
-- A workspace never loses its last admin with an account: deleting a user who is the only admin
-- of a workspace fails, so `requestAccountDeletion` answers `sole_workspace_admin` even when a
-- concurrent change slipped past its check. Re-applying an account tombstone after a restore
-- (`applyTombstones`) still deletes the user: a deleted account always stays deleted.
CREATE TRIGGER `users_refuse_deleting_sole_workspace_admin`
BEFORE DELETE ON `users`
WHEN EXISTS (
  SELECT 1 FROM `workspace_members` AS `mine`
  WHERE `mine`.`user_id` = OLD.`id` AND `mine`.`role` = 'admin'
    AND NOT EXISTS (
      SELECT 1 FROM `workspace_members` AS `other`
      WHERE `other`.`workspace_id` = `mine`.`workspace_id` AND `other`.`role` = 'admin'
        AND `other`.`user_id` <> OLD.`id`
    )
) AND NOT EXISTS (SELECT 1 FROM `tombstones` WHERE `kind` = 'account' AND `id` = OLD.`id`)
BEGIN
  SELECT RAISE(ABORT, 'sole_workspace_admin');
END;
