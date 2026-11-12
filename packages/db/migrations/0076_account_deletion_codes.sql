CREATE TABLE `account_deletion_codes` (
	`user_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_deletion_codes_session_idx` ON `account_deletion_codes` (`session_id`);--> statement-breakpoint
CREATE INDEX `account_deletion_codes_expires_idx` ON `account_deletion_codes` (`expires_at`);