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
CREATE INDEX `webhook_deliveries_webhook_idx` ON `webhook_deliveries` (`webhook_id`,`at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_owner_idx` ON `webhook_deliveries` (`owner_id`,`at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_at_idx` ON `webhook_deliveries` (`at`);--> statement-breakpoint
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
	PRIMARY KEY(`webhook_id`, `artifact_id`, `type`),
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_events_first_idx` ON `webhook_events` (`webhook_id`,`first_at`);--> statement-breakpoint
CREATE TABLE `webhooks` (
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
	CONSTRAINT "webhooks_events" CHECK("webhooks"."events" between 1 and 31),
	CONSTRAINT "webhooks_failures" CHECK("webhooks"."failures" >= 0)
);
--> statement-breakpoint
CREATE INDEX `webhooks_owner_idx` ON `webhooks` (`owner_id`);