CREATE TABLE `read_handoffs` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`user_id` text NOT NULL,
	`state_hash` text NOT NULL,
	`auth_session_id` text NOT NULL,
	`policy_generation` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`session_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`auth_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `read_handoffs_expires_idx` ON `read_handoffs` (`expires_at`);--> statement-breakpoint
CREATE INDEX `read_handoffs_auth_session_idx` ON `read_handoffs` (`auth_session_id`);--> statement-breakpoint
CREATE TABLE `read_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`user_id` text NOT NULL,
	`auth_session_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`auth_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `read_sessions_expires_idx` ON `read_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `read_sessions_user_idx` ON `read_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `read_sessions_artifact_idx` ON `read_sessions` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `read_sessions_auth_session_idx` ON `read_sessions` (`auth_session_id`);