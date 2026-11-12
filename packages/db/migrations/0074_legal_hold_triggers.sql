-- Legal holds (docs/operations.md, "Legal holds"): the database backs the services, so no path
-- the services miss can delete, move or bring back into service an artifact the operator must
-- preserve. A hold is open while `released_at` is null.
-- A held artifact is suspended (so it is served to nobody), and stays so.
CREATE TRIGGER `legal_holds_need_suspension`
BEFORE INSERT ON `legal_holds`
WHEN NEW.`released_at` IS NULL AND NOT EXISTS (
  SELECT 1 FROM `artifacts` WHERE `id` = NEW.`artifact_id` AND `state` = 'suspended'
)
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_needs_suspension');
END;
--> statement-breakpoint
CREATE TRIGGER `artifacts_held_stay_suspended`
BEFORE UPDATE OF `state` ON `artifacts`
WHEN OLD.`state` = 'suspended' AND NEW.`state` <> 'suspended' AND EXISTS (
  SELECT 1 FROM `legal_holds` WHERE `artifact_id` = OLD.`id` AND `released_at` IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'legal_hold');
END;
--> statement-breakpoint
CREATE TRIGGER `artifacts_held_keep_owner`
BEFORE UPDATE OF `owner_id` ON `artifacts`
WHEN NEW.`owner_id` <> OLD.`owner_id` AND EXISTS (
  SELECT 1 FROM `legal_holds` WHERE `artifact_id` = OLD.`id` AND `released_at` IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'legal_hold');
END;
--> statement-breakpoint
CREATE TRIGGER `artifacts_held_not_deleted`
BEFORE DELETE ON `artifacts`
WHEN EXISTS (
  SELECT 1 FROM `legal_holds` WHERE `artifact_id` = OLD.`id` AND `released_at` IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'legal_hold');
END;
--> statement-breakpoint
-- Committed versions are the content; an upload that never committed may still be cleaned up.
CREATE TRIGGER `versions_held_not_deleted`
BEFORE DELETE ON `versions`
WHEN OLD.`state` = 'committed' AND EXISTS (
  SELECT 1 FROM `legal_holds` WHERE `artifact_id` = OLD.`artifact_id` AND `released_at` IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'legal_hold');
END;
