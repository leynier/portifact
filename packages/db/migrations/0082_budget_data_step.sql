-- The data step of budget protection (decision 0026): `pause_data_writes` becomes the second of
-- five steps, so an override's step count moves up by one from 2 to keep the steps it applied.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_platform_budget` (
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
	CONSTRAINT "platform_budget_single_row" CHECK("__new_platform_budget"."id" = 'global'),
	CONSTRAINT "platform_budget_override_steps" CHECK("__new_platform_budget"."override_steps" is null or "__new_platform_budget"."override_steps" between 1 and 5)
);
--> statement-breakpoint
INSERT INTO `__new_platform_budget`("id", "cycle_start", "level", "actions", "projected_cents", "metrics", "analytics", "measured_at", "level_changed_at", "override_level", "override_steps", "override_until", "override_note", "override_set_at") SELECT "id", "cycle_start", "level", "actions", "projected_cents", "metrics", "analytics", "measured_at", "level_changed_at", "override_level", case when "override_steps" >= 2 then "override_steps" + 1 else "override_steps" end, "override_until", "override_note", "override_set_at" FROM `platform_budget`;--> statement-breakpoint
DROP TABLE `platform_budget`;--> statement-breakpoint
ALTER TABLE `__new_platform_budget` RENAME TO `platform_budget`;--> statement-breakpoint
PRAGMA foreign_keys=ON;