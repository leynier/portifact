CREATE TABLE `legal_hold_identities` (
	`hold_id` text NOT NULL,
	`role` text NOT NULL,
	`version_id` text DEFAULT '' NOT NULL,
	`actor_id` text NOT NULL,
	`email` text,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`hold_id`, `role`, `version_id`, `actor_id`)
);
