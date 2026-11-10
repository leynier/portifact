-- Content search (premium plan T8, decision 0012). The full-text table and the triggers that keep
-- the index to active artifacts of their current owner. Drizzle does not model virtual tables or
-- triggers, so they live in this custom migration; `generate` keeps reporting nothing to migrate.
--
-- One row per chunk of about 4,000 characters (`search_chunks`), so `snippet()` never works on a
-- whole file: on one 512 KiB row a frequent word took tens of seconds. `owner` holds one token per
-- row (`ownerToken` in packages/domain), so every MATCH names the owner in a column filter and no
-- search leaves it. `body` is the extracted text with CJK characters separated (`segmentText`).
CREATE VIRTUAL TABLE `search_text` USING fts5(owner, body, tokenize = 'unicode61 remove_diacritics 2');
--> statement-breakpoint
-- A chunk's text goes with it: a reindex, the cascade from `search_artifacts` and from the artifact.
CREATE TRIGGER `search_chunks_delete_text` AFTER DELETE ON `search_chunks` BEGIN
  DELETE FROM `search_text` WHERE rowid = old.`id`;
END;
--> statement-breakpoint
-- An artifact that stops being active (archived, suspended, purging, deleted) is no longer
-- searchable, whatever path changed its state; a restore or a reinstatement indexes it again
-- through a job or the scheduled scan. Rebuilding `artifacts` in a later migration drops these
-- two triggers: recreate them there.
CREATE TRIGGER `artifacts_search_inactive` AFTER UPDATE OF `state` ON `artifacts`
WHEN new.`state` <> 'active' BEGIN
  DELETE FROM `search_artifacts` WHERE `artifact_id` = new.`id`;
END;
--> statement-breakpoint
-- A transfer: the rows were the old owner's; the new owner's are written by the transfer's job.
CREATE TRIGGER `artifacts_search_moved` AFTER UPDATE OF `owner_id` ON `artifacts`
WHEN new.`owner_id` <> old.`owner_id` BEGIN
  DELETE FROM `search_artifacts` WHERE `artifact_id` = new.`id`;
END;
