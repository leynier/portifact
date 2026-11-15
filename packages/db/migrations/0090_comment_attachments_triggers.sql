-- Comment attachments (decision 0029). An attached file's size counts in its owner's comment
-- storage (`annotation_usage.bytes`, refused past the limit by its CHECK constraint), moves with a
-- transfer and goes with the row, as change-list items do (0078). A pending upload counts nowhere.
CREATE TRIGGER `comment_attachments_usage_attach`
AFTER UPDATE OF `state` ON `comment_attachments`
WHEN OLD.`state` = 'pending' AND NEW.`state` = 'attached'
BEGIN
  INSERT OR IGNORE INTO `annotation_usage` (`owner_id`, `messages`, `bytes`) VALUES (NEW.`owner_id`, 0, 0);
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` + NEW.`size`
  WHERE `owner_id` = NEW.`owner_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `comment_attachments_usage_delete`
AFTER DELETE ON `comment_attachments`
WHEN OLD.`state` = 'attached'
BEGIN
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` - OLD.`size`
  WHERE `owner_id` = OLD.`owner_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `comment_attachments_usage_owner`
AFTER UPDATE OF `owner_id` ON `comment_attachments`
WHEN OLD.`owner_id` <> NEW.`owner_id` AND NEW.`state` = 'attached'
BEGIN
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` - OLD.`size`
  WHERE `owner_id` = OLD.`owner_id`;
  INSERT OR IGNORE INTO `annotation_usage` (`owner_id`, `messages`, `bytes`) VALUES (NEW.`owner_id`, 0, 0);
  UPDATE `annotation_usage`
  SET `bytes` = `bytes` + NEW.`size`
  WHERE `owner_id` = NEW.`owner_id`;
END;
--> statement-breakpoint
-- Every deleted row, pending or attached and whatever deleted it (its message, thread or artifact
-- by cascade, the pending prune, account deletion, the operator), writes the `delete_objects` job
-- for its key in the same statement, so no deletion path needs code of its own. The job keeps a
-- key a row names again (`deleteUnreferencedKeys`). Columns in schema order: id, topic, payload,
-- available, dispatched, attempts, created, subject, generation.
CREATE TRIGGER `comment_attachments_release`
AFTER DELETE ON `comment_attachments`
BEGIN
  INSERT INTO `outbox` (`id`, `topic`, `payload`, `available_at`, `dispatched_at`, `attempts`, `created_at`, `subject`, `generation`)
  VALUES (
    NULL,
    'delete_objects',
    json_object('keys', json_array('attachments/' || OLD.`artifact_id` || '/' || OLD.`id`)),
    unixepoch() * 1000,
    NULL,
    0,
    unixepoch() * 1000,
    OLD.`owner_id`,
    NULL
  );
END;
--> statement-breakpoint
-- A message that becomes a deleted marker (others replied to it) keeps its row, so its files go
-- here; a message row that is deleted takes them by its foreign key.
CREATE TRIGGER `annotation_messages_attachments_deleted`
AFTER UPDATE OF `state` ON `annotation_messages`
WHEN NEW.`state` = 'deleted' AND OLD.`state` <> 'deleted'
BEGIN
  DELETE FROM `comment_attachments` WHERE `message_id` = NEW.`id`;
END;
