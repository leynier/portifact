CREATE TABLE `traffic_counters` (
	`owner_id` text NOT NULL,
	`cycle_start` integer NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `cycle_start`),
	CONSTRAINT "traffic_counters_nonnegative" CHECK("traffic_counters"."requests" >= 0 and "traffic_counters"."bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `traffic_counters_cycle_idx` ON `traffic_counters` (`cycle_start`);