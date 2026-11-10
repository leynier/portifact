CREATE TABLE `workspace_deletions` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`requested_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "workspace_invitations_role" CHECK("workspace_invitations"."role" in ('admin', 'editor', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invitations_token_idx` ON `workspace_invitations` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invitations_workspace_email_idx` ON `workspace_invitations` (`workspace_id`,`email`);--> statement-breakpoint
CREATE INDEX `workspace_invitations_email_idx` ON `workspace_invitations` (`email`);--> statement-breakpoint
DROP INDEX `objects_r2_key_idx`;--> statement-breakpoint
CREATE INDEX `objects_r2_key_idx` ON `objects` (`r2_key`);--> statement-breakpoint
-- A workspace always keeps an admin (premium plan F3): demoting or removing its last admin
-- fails, so of two concurrent demotions of its two admins exactly one succeeds. Deleting the
-- workspace (a `workspace_deletions` row is written first in the same batch) and re-applying an
-- account tombstone after a restore still remove the membership.
CREATE TRIGGER `workspace_members_keep_admin_on_update`
BEFORE UPDATE OF `role` ON `workspace_members`
WHEN OLD.`role` = 'admin' AND NEW.`role` <> 'admin' AND NOT EXISTS (
  SELECT 1 FROM `workspace_members` AS `other`
  WHERE `other`.`workspace_id` = OLD.`workspace_id` AND `other`.`role` = 'admin'
    AND `other`.`user_id` <> OLD.`user_id`
)
BEGIN
  SELECT RAISE(ABORT, 'sole_workspace_admin');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_members_keep_admin_on_delete`
BEFORE DELETE ON `workspace_members`
WHEN OLD.`role` = 'admin' AND NOT EXISTS (
  SELECT 1 FROM `workspace_members` AS `other`
  WHERE `other`.`workspace_id` = OLD.`workspace_id` AND `other`.`role` = 'admin'
    AND `other`.`user_id` <> OLD.`user_id`
) AND NOT EXISTS (
  SELECT 1 FROM `workspace_deletions` WHERE `workspace_id` = OLD.`workspace_id`
) AND NOT EXISTS (
  SELECT 1 FROM `tombstones` WHERE `kind` = 'account' AND `id` = OLD.`user_id`
)
BEGIN
  SELECT RAISE(ABORT, 'sole_workspace_admin');
END;
--> statement-breakpoint
-- A transfer moves an artifact to another owner (packages/services/src/transfer.ts). An active
-- artifact takes its slot with it: the target's CHECK on `active_limit` refuses the move when
-- the target has no room, which fails the whole batch.
CREATE TRIGGER `artifacts_transfer_moves_slot`
AFTER UPDATE OF `owner_id` ON `artifacts`
WHEN OLD.`owner_id` <> NEW.`owner_id` AND NEW.`state` = 'active'
BEGIN
  UPDATE `account_usage`
  SET `active_artifacts` = `active_artifacts` - 1
  WHERE `owner_id` = OLD.`owner_id`;
  INSERT OR IGNORE INTO `account_usage` (`owner_id`, `month_started_at`)
  VALUES (NEW.`owner_id`, CAST(strftime('%s', 'now', 'start of month') AS INTEGER) * 1000);
  UPDATE `account_usage`
  SET `active_artifacts` = `active_artifacts` + 1
  WHERE `owner_id` = NEW.`owner_id`;
END;
--> statement-breakpoint
-- Annotation usage follows the comments of a transferred artifact (0007 keeps it exact on every
-- other write); the target's CHECK constraints refuse a move over its limits.
CREATE TRIGGER `annotation_messages_usage_owner`
AFTER UPDATE OF `owner_id` ON `annotation_messages`
WHEN OLD.`owner_id` <> NEW.`owner_id`
BEGIN
  UPDATE `annotation_usage`
  SET `messages` = `messages` - (OLD.`state` <> 'deleted'),
      `bytes` = `bytes` - OLD.`body_bytes`
  WHERE `owner_id` = OLD.`owner_id`;
  INSERT OR IGNORE INTO `annotation_usage` (`owner_id`, `messages`, `bytes`) VALUES (NEW.`owner_id`, 0, 0);
  UPDATE `annotation_usage`
  SET `messages` = `messages` + (NEW.`state` <> 'deleted'),
      `bytes` = `bytes` + NEW.`body_bytes`
  WHERE `owner_id` = NEW.`owner_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `annotation_threads_usage_owner`
AFTER UPDATE OF `owner_id` ON `annotation_threads`
WHEN OLD.`owner_id` <> NEW.`owner_id`
BEGIN
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` - OLD.`target_bytes`
  WHERE `owner_id` = OLD.`owner_id`;
  INSERT OR IGNORE INTO `annotation_usage` (`owner_id`, `messages`, `bytes`) VALUES (NEW.`owner_id`, 0, 0);
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` + NEW.`target_bytes`
  WHERE `owner_id` = NEW.`owner_id`;
END;
