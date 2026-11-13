-- Edit suggestions (decision 0027). The suggestion columns were added to `annotation_threads`
-- with `alter table add column`, which cannot add table CHECK constraints, so their rules are
-- these triggers. A comment carries none of them; a suggestion always has a state, its edit is
-- set when it is submitted and never changes after (only a withdrawal clears it), `edit_bytes`
-- is the edit's UTF-8 size, an undecided suggestion's thread is never resolved, and a decided or
-- withdrawn suggestion stays so.
CREATE TRIGGER `annotation_threads_suggestion_insert`
BEFORE INSERT ON `annotation_threads`
WHEN NOT (CASE NEW.`kind`
  WHEN 'comment' THEN NEW.`suggestion_state` IS NULL AND NEW.`edit` IS NULL AND NEW.`edit_bytes` = 0
    AND NEW.`edit_proofs` IS NULL AND NEW.`suggestion_revision` = 0 AND NEW.`attempt_id` IS NULL
    AND NEW.`attempt_reason` IS NULL AND NEW.`decided_by` IS NULL AND NEW.`decided_at` IS NULL
    AND NEW.`result_version_id` IS NULL AND NEW.`origin_version_id` IS NULL AND NEW.`origin_target` IS NULL
  WHEN 'suggestion' THEN coalesce(NEW.`suggestion_state` IN ('pending', 'applying', 'accepted', 'rejected', 'withdrawn', 'outdated'), 0)
    AND NEW.`edit_bytes` = coalesce(length(CAST(NEW.`edit` AS BLOB)), 0) AND NEW.`edit_bytes` <= 32768
    AND (NEW.`edit` IS NULL) = (NEW.`suggestion_state` = 'withdrawn')
    AND (NEW.`edit_proofs` IS NULL OR NEW.`edit` IS NOT NULL)
    AND (NEW.`attempt_id` IS NOT NULL) = (NEW.`suggestion_state` = 'applying')
    AND (NEW.`attempt_reason` IS NULL OR NEW.`suggestion_state` = 'pending')
    AND (NEW.`decided_at` IS NOT NULL) = (NEW.`suggestion_state` IN ('accepted', 'rejected'))
    AND (NEW.`decided_by` IS NULL OR NEW.`decided_at` IS NOT NULL)
    AND (NEW.`result_version_id` IS NULL OR NEW.`suggestion_state` = 'accepted')
    AND (NEW.`state` = 'open' OR NEW.`suggestion_state` NOT IN ('pending', 'applying'))
    AND NEW.`suggestion_revision` >= 0
  ELSE 0 END)
BEGIN
  SELECT RAISE(ABORT, 'annotation_threads_suggestion');
END;
--> statement-breakpoint
CREATE TRIGGER `annotation_threads_suggestion_update`
BEFORE UPDATE ON `annotation_threads`
WHEN NOT (CASE NEW.`kind`
  WHEN 'comment' THEN NEW.`suggestion_state` IS NULL AND NEW.`edit` IS NULL AND NEW.`edit_bytes` = 0
    AND NEW.`edit_proofs` IS NULL AND NEW.`suggestion_revision` = 0 AND NEW.`attempt_id` IS NULL
    AND NEW.`attempt_reason` IS NULL AND NEW.`decided_by` IS NULL AND NEW.`decided_at` IS NULL
    AND NEW.`result_version_id` IS NULL AND NEW.`origin_version_id` IS NULL AND NEW.`origin_target` IS NULL
  WHEN 'suggestion' THEN coalesce(NEW.`suggestion_state` IN ('pending', 'applying', 'accepted', 'rejected', 'withdrawn', 'outdated'), 0)
    AND NEW.`edit_bytes` = coalesce(length(CAST(NEW.`edit` AS BLOB)), 0) AND NEW.`edit_bytes` <= 32768
    AND (NEW.`edit` IS NULL) = (NEW.`suggestion_state` = 'withdrawn')
    AND (NEW.`edit_proofs` IS NULL OR NEW.`edit` IS NOT NULL)
    AND (NEW.`attempt_id` IS NOT NULL) = (NEW.`suggestion_state` = 'applying')
    AND (NEW.`attempt_reason` IS NULL OR NEW.`suggestion_state` = 'pending')
    AND (NEW.`decided_at` IS NOT NULL) = (NEW.`suggestion_state` IN ('accepted', 'rejected'))
    AND (NEW.`decided_by` IS NULL OR NEW.`decided_at` IS NOT NULL)
    AND (NEW.`result_version_id` IS NULL OR NEW.`suggestion_state` = 'accepted')
    AND (NEW.`state` = 'open' OR NEW.`suggestion_state` NOT IN ('pending', 'applying'))
    AND NEW.`suggestion_revision` >= 0
  ELSE 0 END)
BEGIN
  SELECT RAISE(ABORT, 'annotation_threads_suggestion');
END;
--> statement-breakpoint
CREATE TRIGGER `annotation_threads_suggestion_immutable`
BEFORE UPDATE ON `annotation_threads`
WHEN NEW.`kind` IS NOT OLD.`kind`
  OR (NEW.`edit` IS NOT OLD.`edit` AND NEW.`edit` IS NOT NULL)
  OR (OLD.`suggestion_state` IN ('accepted', 'rejected', 'withdrawn') AND NEW.`suggestion_state` IS NOT OLD.`suggestion_state`)
BEGIN
  SELECT RAISE(ABORT, 'annotation_threads_suggestion_immutable');
END;
--> statement-breakpoint
-- A suggestion's edit counts in its owner's annotation bytes like its target (decision 0027,
-- "The edit model"): the usage triggers of 0027 and 0036 on `annotation_threads` are recreated
-- with `edit_bytes`, and a withdrawal that clears the edit gives its bytes back.
DROP TRIGGER IF EXISTS `annotation_threads_usage_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `annotation_threads_usage_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `annotation_threads_usage_owner`;
--> statement-breakpoint
CREATE TRIGGER `annotation_threads_usage_insert`
AFTER INSERT ON `annotation_threads`
BEGIN
  INSERT OR IGNORE INTO `annotation_usage` (`owner_id`, `messages`, `bytes`) VALUES (NEW.`owner_id`, 0, 0);
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` + NEW.`target_bytes` + NEW.`edit_bytes`
  WHERE `owner_id` = NEW.`owner_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `annotation_threads_usage_delete`
AFTER DELETE ON `annotation_threads`
BEGIN
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` - OLD.`target_bytes` - OLD.`edit_bytes`
  WHERE `owner_id` = OLD.`owner_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `annotation_threads_usage_owner`
AFTER UPDATE OF `owner_id` ON `annotation_threads`
WHEN OLD.`owner_id` <> NEW.`owner_id`
BEGIN
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` - OLD.`target_bytes` - OLD.`edit_bytes`
  WHERE `owner_id` = OLD.`owner_id`;
  INSERT OR IGNORE INTO `annotation_usage` (`owner_id`, `messages`, `bytes`) VALUES (NEW.`owner_id`, 0, 0);
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` + NEW.`target_bytes` + NEW.`edit_bytes`
  WHERE `owner_id` = NEW.`owner_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `annotation_threads_usage_edit`
AFTER UPDATE OF `edit_bytes` ON `annotation_threads`
WHEN OLD.`edit_bytes` <> NEW.`edit_bytes` AND OLD.`owner_id` = NEW.`owner_id`
BEGIN
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` + NEW.`edit_bytes` - OLD.`edit_bytes`
  WHERE `owner_id` = NEW.`owner_id`;
END;
--> statement-breakpoint
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
CREATE TRIGGER `edit_drafts_limit`
BEFORE INSERT ON `edit_drafts`
WHEN NOT EXISTS (
  SELECT 1 FROM `edit_drafts` WHERE `artifact_id` = NEW.`artifact_id` AND `user_id` = NEW.`user_id`
) AND (SELECT count(*) FROM `edit_drafts` WHERE `user_id` = NEW.`user_id`) >= 20
BEGIN
  SELECT RAISE(ABORT, 'edit_drafts_limit');
END;
--> statement-breakpoint
-- At most 10 open preview codes per person (decision 0027, "Costs and limits"): open means not
-- redeemed and not expired when the new one is made.
CREATE TRIGGER `preview_codes_limit`
BEFORE INSERT ON `preview_codes`
WHEN (
  SELECT count(*) FROM `preview_codes`
  WHERE `user_id` = NEW.`user_id` AND `redeemed_at` IS NULL AND `expires_at` > NEW.`created_at`
) >= 10
BEGIN
  SELECT RAISE(ABORT, 'preview_codes_limit');
END;
