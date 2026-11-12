-- Rebuilding `change_items` (0079, its origin and state CHECKs) dropped its triggers: they are
-- recreated here unchanged.
-- Change-list items count in the owner's annotation bytes (envelope and proof, decision 0027,
-- "Costs and limits"), and follow the artifact on a transfer. Their envelope and proof never
-- change, so neither do their bytes.
CREATE TRIGGER `change_items_usage_insert`
AFTER INSERT ON `change_items`
BEGIN
  INSERT OR IGNORE INTO `annotation_usage` (`owner_id`, `messages`, `bytes`) VALUES (NEW.`owner_id`, 0, 0);
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` + NEW.`bytes`
  WHERE `owner_id` = NEW.`owner_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `change_items_usage_delete`
AFTER DELETE ON `change_items`
BEGIN
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` - OLD.`bytes`
  WHERE `owner_id` = OLD.`owner_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `change_items_usage_owner`
AFTER UPDATE OF `owner_id` ON `change_items`
WHEN OLD.`owner_id` <> NEW.`owner_id`
BEGIN
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` - OLD.`bytes`
  WHERE `owner_id` = OLD.`owner_id`;
  INSERT OR IGNORE INTO `annotation_usage` (`owner_id`, `messages`, `bytes`) VALUES (NEW.`owner_id`, 0, 0);
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` + NEW.`bytes`
  WHERE `owner_id` = NEW.`owner_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `change_items_immutable`
BEFORE UPDATE OF `envelope`, `proof`, `bytes`, `artifact_id`, `origin` ON `change_items`
WHEN NEW.`envelope` IS NOT OLD.`envelope` OR NEW.`proof` IS NOT OLD.`proof`
  OR NEW.`bytes` IS NOT OLD.`bytes` OR NEW.`artifact_id` IS NOT OLD.`artifact_id`
  OR NEW.`origin` IS NOT OLD.`origin`
BEGIN
  SELECT RAISE(ABORT, 'change_items_immutable');
END;
--> statement-breakpoint
-- At most 1,000 open items per artifact. The acceptance claim reserves room for a whole listed
-- set before any is written; this is the database's backstop for any path that misses it.
CREATE TRIGGER `change_items_open_limit_insert`
BEFORE INSERT ON `change_items`
WHEN NEW.`state` = 'open' AND (
  SELECT count(*) FROM `change_items` WHERE `artifact_id` = NEW.`artifact_id` AND `state` = 'open'
) >= 1000
BEGIN
  SELECT RAISE(ABORT, 'change_items_open_limit');
END;
--> statement-breakpoint
CREATE TRIGGER `change_items_open_limit_reopen`
BEFORE UPDATE OF `state` ON `change_items`
WHEN NEW.`state` = 'open' AND OLD.`state` <> 'open' AND (
  SELECT count(*) FROM `change_items` WHERE `artifact_id` = NEW.`artifact_id` AND `state` = 'open'
) >= 1000
BEGIN
  SELECT RAISE(ABORT, 'change_items_open_limit');
END;
--> statement-breakpoint
-- At most 20 drafts per person (decision 0027, "The owner's draft"). Saving a draft the person
-- already has is an upsert on its key, which SQLite tries as an insert first: it is not a new
-- draft and never refused here.
DROP TRIGGER `edit_drafts_limit`;
--> statement-breakpoint
CREATE TRIGGER `edit_drafts_limit`
BEFORE INSERT ON `edit_drafts`
WHEN NOT EXISTS (
  SELECT 1 FROM `edit_drafts` WHERE `artifact_id` = NEW.`artifact_id` AND `user_id` = NEW.`user_id`
) AND (SELECT count(*) FROM `edit_drafts` WHERE `user_id` = NEW.`user_id`) >= 20
BEGIN
  SELECT RAISE(ABORT, 'edit_drafts_limit');
END;
