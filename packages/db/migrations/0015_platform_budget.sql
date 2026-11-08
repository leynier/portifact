CREATE TABLE `budget_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cycle_start` integer NOT NULL,
	`kind` text NOT NULL,
	`level` text NOT NULL,
	`projected_cents` integer NOT NULL,
	`created_at` integer NOT NULL,
	`notified_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_alerts_cycle_kind_idx` ON `budget_alerts` (`cycle_start`,`kind`);--> statement-breakpoint
CREATE TABLE `platform_budget` (
	`id` text PRIMARY KEY DEFAULT 'global' NOT NULL,
	`cycle_start` integer NOT NULL,
	`level` text DEFAULT 'none' NOT NULL,
	`actions` text DEFAULT '[]' NOT NULL,
	`projected_cents` integer DEFAULT 0 NOT NULL,
	`metrics` text NOT NULL,
	`analytics` text DEFAULT 'off' NOT NULL,
	`measured_at` integer NOT NULL,
	`level_changed_at` integer NOT NULL,
	`override_level` text,
	`override_steps` integer,
	`override_until` integer,
	`override_note` text,
	`override_set_at` integer,
	CONSTRAINT "platform_budget_single_row" CHECK("platform_budget"."id" = 'global'),
	CONSTRAINT "platform_budget_override_steps" CHECK("platform_budget"."override_steps" is null or "platform_budget"."override_steps" between 1 and 4)
);
