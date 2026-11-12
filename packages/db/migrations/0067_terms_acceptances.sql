CREATE TABLE `terms_acceptances` (
	`user_id` text NOT NULL,
	`version` text NOT NULL,
	`accepted_at` integer NOT NULL,
	`action` text NOT NULL,
	PRIMARY KEY(`user_id`, `version`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "terms_acceptances_action" CHECK("terms_acceptances"."action" in ('sign_up', 'sign_in', 'review', 'backfill'))
);
