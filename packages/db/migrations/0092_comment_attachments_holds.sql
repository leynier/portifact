-- Comment attachments and legal holds (decision 0029): like the triggers of migration 0074, the
-- database refuses deleting a file of an artifact a legal hold keeps, whatever path tries (a
-- cascade, account deletion, the operator), so a race the services miss fails the statement
-- instead of losing the bytes.
CREATE TRIGGER `comment_attachments_held_not_deleted`
BEFORE DELETE ON `comment_attachments`
WHEN EXISTS (
  SELECT 1 FROM `legal_holds` WHERE `artifact_id` = OLD.`artifact_id` AND `released_at` IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'legal_hold');
END;
--> statement-breakpoint
-- A deleted row's bytes are deleted twice: at once, and again once every upload link signed for
-- it has expired (`ATTACHMENT_LIMITS.finalCleanupDelayMs`, 20 minutes, longer than the 15 minutes
-- of `UPLOAD_URL_TTL_SECONDS`), so a PUT replayed after the first deletion leaves nothing behind.
-- Each job keeps the key if a row names it again (`deleteUnreferencedKeys`). Columns in schema
-- order: id, topic, payload, available, dispatched, attempts, created, subject, generation.
DROP TRIGGER `comment_attachments_release`;
--> statement-breakpoint
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
  INSERT INTO `outbox` (`id`, `topic`, `payload`, `available_at`, `dispatched_at`, `attempts`, `created_at`, `subject`, `generation`)
  VALUES (
    NULL,
    'delete_objects',
    json_object('keys', json_array('attachments/' || OLD.`artifact_id` || '/' || OLD.`id`)),
    unixepoch() * 1000 + 1200000,
    NULL,
    0,
    unixepoch() * 1000,
    OLD.`owner_id`,
    NULL
  );
END;
