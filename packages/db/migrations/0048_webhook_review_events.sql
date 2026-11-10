-- Review events for webhooks (decisions 0009 and 0013): `review.requested` and `review.completed`
-- take bits 32 and 64 of `webhooks.events`, so its CHECK grows from 31 to 127, and pending events
-- keep the review's status and counts in `webhook_events.review`. Stored subscriptions keep their
-- bits and their meaning: new types are only ever appended to WEBHOOK_EVENTS.
--
-- SQLite cannot alter a CHECK constraint, so `webhooks` is rebuilt. Dropping it would make the
-- foreign keys cascade its implicit DELETE into `webhook_events` and `webhook_deliveries` (D1
-- keeps foreign keys on and actions fire even when deferred), so both children are copied aside
-- and dropped first, the parent is rebuilt with every row, and the children are recreated with
-- their exact definitions and indexes and filled back. No trigger is defined on or writes these
-- tables. `webhook_deliveries` is AUTOINCREMENT: dropping it resets its `sqlite_sequence` counter
-- to the highest ID copied back, which would hand out again the IDs of deliveries of removed
-- webhooks, so the old counter is saved first and written back after the rows are restored (the
-- row may be missing when the table never had a delivery). The migration runs in one
-- transaction, so a failure leaves everything as it was.
CREATE TABLE `__keep_webhook_events` AS SELECT * FROM `webhook_events`;
--> statement-breakpoint
CREATE TABLE `__keep_webhook_deliveries` AS SELECT * FROM `webhook_deliveries`;
--> statement-breakpoint
CREATE TABLE `__keep_webhook_deliveries_seq` AS SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'webhook_deliveries';
--> statement-breakpoint
DROP TABLE `webhook_events`;
--> statement-breakpoint
DROP TABLE `webhook_deliveries`;
--> statement-breakpoint
CREATE TABLE `__new_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`host` text NOT NULL,
	`format` text NOT NULL,
	`events` integer NOT NULL,
	`key_id` text NOT NULL,
	`url_box` text NOT NULL,
	`secret_box` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`disabled_at` integer,
	`disabled_reason` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`probation` integer DEFAULT false NOT NULL,
	`reenables` integer DEFAULT 0 NOT NULL,
	`reenable_day` integer,
	`created_by` text,
	`created_via` text NOT NULL,
	CONSTRAINT "webhooks_events" CHECK("events" between 1 and 127),
	CONSTRAINT "webhooks_failures" CHECK("failures" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_webhooks`("id", "owner_id", "host", "format", "events", "key_id", "url_box", "secret_box", "created_at", "disabled_at", "disabled_reason", "failures", "probation", "reenables", "reenable_day", "created_by", "created_via") SELECT "id", "owner_id", "host", "format", "events", "key_id", "url_box", "secret_box", "created_at", "disabled_at", "disabled_reason", "failures", "probation", "reenables", "reenable_day", "created_by", "created_via" FROM `webhooks`;
--> statement-breakpoint
DROP TABLE `webhooks`;
--> statement-breakpoint
ALTER TABLE `__new_webhooks` RENAME TO `webhooks`;
--> statement-breakpoint
CREATE INDEX `webhooks_owner_idx` ON `webhooks` (`owner_id`);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`webhook_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`delivery_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`at` integer NOT NULL,
	`outcome` text NOT NULL,
	`status` integer,
	`error` text,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `webhook_deliveries`("id", "webhook_id", "owner_id", "delivery_id", "attempt", "at", "outcome", "status", "error") SELECT "id", "webhook_id", "owner_id", "delivery_id", "attempt", "at", "outcome", "status", "error" FROM `__keep_webhook_deliveries`;
--> statement-breakpoint
UPDATE `sqlite_sequence` SET `seq` = max(`seq`, (SELECT `seq` FROM `__keep_webhook_deliveries_seq`)) WHERE `name` = 'webhook_deliveries' AND EXISTS (SELECT 1 FROM `__keep_webhook_deliveries_seq`);
--> statement-breakpoint
INSERT INTO `sqlite_sequence` (`name`, `seq`) SELECT 'webhook_deliveries', `seq` FROM `__keep_webhook_deliveries_seq` WHERE NOT EXISTS (SELECT 1 FROM `sqlite_sequence` WHERE `name` = 'webhook_deliveries');
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_webhook_idx` ON `webhook_deliveries` (`webhook_id`,`at`);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_owner_idx` ON `webhook_deliveries` (`owner_id`,`at`);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_at_idx` ON `webhook_deliveries` (`at`);
--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`webhook_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`type` text NOT NULL,
	`count` integer NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`actor_id` text,
	`version` integer,
	`access` text,
	`expires_at` integer,
	`review` text,
	PRIMARY KEY(`webhook_id`, `artifact_id`, `type`),
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `webhook_events`("webhook_id", "artifact_id", "type", "count", "first_at", "last_at", "actor_id", "version", "access", "expires_at", "review") SELECT "webhook_id", "artifact_id", "type", "count", "first_at", "last_at", "actor_id", "version", "access", "expires_at", null FROM `__keep_webhook_events`;
--> statement-breakpoint
CREATE INDEX `webhook_events_first_idx` ON `webhook_events` (`webhook_id`,`first_at`);
--> statement-breakpoint
DROP TABLE `__keep_webhook_events`;
--> statement-breakpoint
DROP TABLE `__keep_webhook_deliveries`;
--> statement-breakpoint
DROP TABLE `__keep_webhook_deliveries_seq`;
