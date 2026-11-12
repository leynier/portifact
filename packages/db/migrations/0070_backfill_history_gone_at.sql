-- When the target of each suspension went (`suspensions.target_gone_at`, migration 0069), for the
-- suspensions of artifacts purged and accounts deleted before the column existed, so their
-- retention (`pruneGoneHistory`) counts from then. An artifact is gone when its row is: the time
-- of its `purged` lifecycle event, else its tombstone's, else now. An account is gone only when
-- its `account` tombstone is in this database (the global one, which is also the default region's,
-- where account suspensions live with the personal space).
UPDATE `suspensions`
SET `target_gone_at` = coalesce(
  (SELECT max(`at`) FROM `lifecycle_events` WHERE `artifact_id` = `suspensions`.`target_id` AND `event` = 'purged'),
  (SELECT `deleted_at` FROM `tombstones` WHERE `kind` = 'artifact' AND `id` = `suspensions`.`target_id`),
  cast(unixepoch('subsecond') * 1000 as integer)
)
WHERE `kind` = 'artifact' AND `target_gone_at` IS NULL
  AND NOT EXISTS (SELECT 1 FROM `artifacts` WHERE `id` = `suspensions`.`target_id`);
--> statement-breakpoint
UPDATE `suspensions`
SET `target_gone_at` = (SELECT `deleted_at` FROM `tombstones` WHERE `kind` = 'account' AND `id` = `suspensions`.`target_id`)
WHERE `kind` = 'account' AND `target_gone_at` IS NULL
  AND EXISTS (SELECT 1 FROM `tombstones` WHERE `kind` = 'account' AND `id` = `suspensions`.`target_id`)
  AND NOT EXISTS (SELECT 1 FROM `users` WHERE `id` = `suspensions`.`target_id`);
