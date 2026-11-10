CREATE TABLE `owner_plans` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`plan` text NOT NULL,
	`seats` integer DEFAULT 1 NOT NULL,
	`valid_until` integer,
	`overrides` text,
	`granted_by` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "owner_plans_plan" CHECK("owner_plans"."plan" in ('free', 'pro', 'team', 'enterprise')),
	CONSTRAINT "owner_plans_seats" CHECK("owner_plans"."seats" >= 1)
);
