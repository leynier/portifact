CREATE TABLE `review_handoffs` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`version_id` text NOT NULL,
	`user_id` text NOT NULL,
	`auth_session_id` text NOT NULL,
	`policy_generation` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`session_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`auth_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_handoffs_expires_idx` ON `review_handoffs` (`expires_at`);--> statement-breakpoint
CREATE INDEX `review_handoffs_auth_session_idx` ON `review_handoffs` (`auth_session_id`);--> statement-breakpoint
CREATE TABLE `review_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`version_id` text NOT NULL,
	`user_id` text NOT NULL,
	`auth_session_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`auth_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_sessions_expires_idx` ON `review_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `review_sessions_user_idx` ON `review_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `review_sessions_artifact_idx` ON `review_sessions` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `review_sessions_auth_session_idx` ON `review_sessions` (`auth_session_id`);