-- Active-slot accounting for lifecycle transitions, enforced by the database.
-- A publish reserves the slot of a new artifact when it is prepared, so draft -> active is
-- not counted here. Archiving frees the slot; restoring takes it again (and the CHECK
-- constraint on account_usage refuses a restore beyond 50 active artifacts); deleting an
-- active artifact frees it. Doing this in triggers keeps the counter exact even when two
-- maintenance runs race on the same artifact, because only the update that changes the
-- state fires the trigger.
CREATE TRIGGER `artifacts_archive_frees_slot`
AFTER UPDATE OF `state` ON `artifacts`
WHEN OLD.`state` = 'active' AND NEW.`state` IN ('archived', 'purging')
BEGIN
  UPDATE `account_usage`
  SET `active_artifacts` = `active_artifacts` - 1
  WHERE `owner_id` = NEW.`owner_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `artifacts_restore_takes_slot`
AFTER UPDATE OF `state` ON `artifacts`
WHEN OLD.`state` = 'archived' AND NEW.`state` = 'active'
BEGIN
  UPDATE `account_usage`
  SET `active_artifacts` = `active_artifacts` + 1
  WHERE `owner_id` = NEW.`owner_id`;
END;
