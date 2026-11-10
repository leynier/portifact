-- Account limits as per-row columns (paid plans, F2). SQLite cannot alter a CHECK constraint, so
-- account_usage and annotation_usage are rebuilt with limit columns whose defaults are today's free
-- plan, and the CHECK constraints compare against them instead of constants. Existing rows keep
-- every value and take the defaults, so nothing changes until a plan writes the columns.
--
-- Neither table has a foreign key or is referenced by one, so no foreign key pragma is needed.
-- Every trigger defined on these tables (0016) or whose body writes them (0001, 0007, 0010) is
-- dropped first and recreated unchanged after the rebuild: dropping a table drops its own
-- triggers, and SQLite refuses to rename a table while a trigger refers to a missing one.
DROP TRIGGER IF EXISTS `artifacts_archive_frees_slot`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `artifacts_restore_takes_slot`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `artifacts_suspend_frees_slot`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `artifacts_reinstate_takes_slot`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `account_usage_open_uploads_limit`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `annotation_messages_usage_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `annotation_messages_usage_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `annotation_messages_usage_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `annotation_threads_usage_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `annotation_threads_usage_delete`;
--> statement-breakpoint
CREATE TABLE `__new_account_usage` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`active_artifacts` integer DEFAULT 0 NOT NULL,
	`stored_bytes` integer DEFAULT 0 NOT NULL,
	`reserved_bytes` integer DEFAULT 0 NOT NULL,
	`open_uploads` integer DEFAULT 0 NOT NULL,
	`new_objects_this_month` integer DEFAULT 0 NOT NULL,
	`month_started_at` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`active_limit` integer DEFAULT 50 NOT NULL,
	`bytes_limit` integer DEFAULT 2500000000 NOT NULL,
	CONSTRAINT "account_usage_nonnegative" CHECK("active_artifacts" >= 0 and "stored_bytes" >= 0 and "reserved_bytes" >= 0 and "open_uploads" >= 0),
	CONSTRAINT "account_usage_limits_nonnegative" CHECK("active_limit" >= 0 and "bytes_limit" >= 0),
	CONSTRAINT "account_usage_active_limit" CHECK("active_artifacts" <= "active_limit"),
	CONSTRAINT "account_usage_bytes_limit" CHECK("stored_bytes" + "reserved_bytes" <= "bytes_limit")
);
--> statement-breakpoint
INSERT INTO `__new_account_usage`("owner_id", "active_artifacts", "stored_bytes", "reserved_bytes", "open_uploads", "new_objects_this_month", "month_started_at", "updated_at") SELECT "owner_id", "active_artifacts", "stored_bytes", "reserved_bytes", "open_uploads", "new_objects_this_month", "month_started_at", "updated_at" FROM `account_usage`;--> statement-breakpoint
DROP TABLE `account_usage`;--> statement-breakpoint
ALTER TABLE `__new_account_usage` RENAME TO `account_usage`;--> statement-breakpoint
CREATE TABLE `__new_annotation_usage` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`messages` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`messages_limit` integer DEFAULT 5000 NOT NULL,
	`bytes_limit` integer DEFAULT 50000000 NOT NULL,
	CONSTRAINT "annotation_usage_nonnegative" CHECK("messages" >= 0 and "bytes" >= 0),
	CONSTRAINT "annotation_usage_limits_nonnegative" CHECK("messages_limit" >= 0 and "bytes_limit" >= 0),
	CONSTRAINT "annotation_usage_messages_limit" CHECK("messages" <= "messages_limit"),
	CONSTRAINT "annotation_usage_bytes_limit" CHECK("bytes" <= "bytes_limit")
);
--> statement-breakpoint
INSERT INTO `__new_annotation_usage`("owner_id", "messages", "bytes") SELECT "owner_id", "messages", "bytes" FROM `annotation_usage`;--> statement-breakpoint
DROP TABLE `annotation_usage`;--> statement-breakpoint
ALTER TABLE `__new_annotation_usage` RENAME TO `annotation_usage`;--> statement-breakpoint
-- The triggers again, as 0001, 0010, 0016 and 0007 define them.
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
END;--> statement-breakpoint
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
END;--> statement-breakpoint
CREATE TRIGGER `account_usage_open_uploads_limit`
BEFORE UPDATE OF `open_uploads` ON `account_usage`
WHEN NEW.`open_uploads` > 2 AND NEW.`open_uploads` > OLD.`open_uploads`
BEGIN
  SELECT RAISE(ABORT, 'account_usage_open_uploads_limit');
END;--> statement-breakpoint
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
