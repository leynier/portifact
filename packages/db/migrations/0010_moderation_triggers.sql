-- Suspension and tombstone rules enforced by the database (plan sections 10 and 13).
-- A suspended artifact does not hold an active slot, like an archived one: suspending an active
-- artifact frees its slot and reinstating it takes the slot again (the CHECK constraint on
-- account_usage refuses that past 50, and the service then reinstates it to the archive).
-- Only the update that changes the state fires these, so concurrent runs count once.
CREATE TRIGGER `artifacts_suspend_frees_slot`
AFTER UPDATE OF `state` ON `artifacts`
WHEN OLD.`state` = 'active' AND NEW.`state` = 'suspended'
BEGIN
  UPDATE `account_usage`
  SET `active_artifacts` = `active_artifacts` - 1
  WHERE `owner_id` = NEW.`owner_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `artifacts_reinstate_takes_slot`
AFTER UPDATE OF `state` ON `artifacts`
WHEN OLD.`state` = 'suspended' AND NEW.`state` = 'active'
BEGIN
  UPDATE `account_usage`
  SET `active_artifacts` = `active_artifacts` + 1
  WHERE `owner_id` = NEW.`owner_id`;
END;
--> statement-breakpoint
-- Artifact IDs are never reused: an ID with a tombstone cannot be inserted again, also after
-- restoring a backup that still holds the purged row's neighbors.
CREATE TRIGGER `artifacts_refuse_tombstoned_id`
BEFORE INSERT ON `artifacts`
WHEN EXISTS (SELECT 1 FROM `tombstones` WHERE `kind` = 'artifact' AND `id` = NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'artifact_id_tombstoned');
END;
