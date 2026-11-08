-- Annotation usage per artifact owner (plan section 2: 5,000 messages and 50 MB per owner).
-- `messages` counts messages that are not deleted; `bytes` adds their body bytes and the target
-- bytes of every thread. Triggers keep the counters exact on every write, including the
-- cascades that purging an artifact or removing a thread run, and the CHECK constraints on
-- `annotation_usage` refuse any write that would pass a limit, so a race the application
-- misses still fails in the database. The INSERT OR IGNORE only creates the zero row; the
-- UPDATE that follows carries no conflict clause, so a CHECK failure aborts the statement.
CREATE TRIGGER `annotation_messages_usage_insert`
AFTER INSERT ON `annotation_messages`
BEGIN
  INSERT OR IGNORE INTO `annotation_usage` (`owner_id`, `messages`, `bytes`) VALUES (NEW.`owner_id`, 0, 0);
  UPDATE `annotation_usage`
  SET `messages` = `messages` + (NEW.`state` <> 'deleted'),
      `bytes` = `bytes` + NEW.`body_bytes`
  WHERE `owner_id` = NEW.`owner_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `annotation_messages_usage_update`
AFTER UPDATE OF `state`, `body_bytes` ON `annotation_messages`
BEGIN
  UPDATE `annotation_usage`
  SET `messages` = `messages` + (NEW.`state` <> 'deleted') - (OLD.`state` <> 'deleted'),
      `bytes` = `bytes` + NEW.`body_bytes` - OLD.`body_bytes`
  WHERE `owner_id` = NEW.`owner_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `annotation_messages_usage_delete`
AFTER DELETE ON `annotation_messages`
BEGIN
  UPDATE `annotation_usage`
  SET `messages` = `messages` - (OLD.`state` <> 'deleted'),
      `bytes` = `bytes` - OLD.`body_bytes`
  WHERE `owner_id` = OLD.`owner_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `annotation_threads_usage_insert`
AFTER INSERT ON `annotation_threads`
BEGIN
  INSERT OR IGNORE INTO `annotation_usage` (`owner_id`, `messages`, `bytes`) VALUES (NEW.`owner_id`, 0, 0);
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` + NEW.`target_bytes`
  WHERE `owner_id` = NEW.`owner_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `annotation_threads_usage_delete`
AFTER DELETE ON `annotation_threads`
BEGIN
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` - OLD.`target_bytes`
  WHERE `owner_id` = OLD.`owner_id`;
END;
