-- Two-region correctness (decision 0005, finding 4): read and review handoffs and sessions are
-- regional, while users and Better Auth sessions are global, so their foreign keys to `users` and
-- `sessions` cannot exist in a regional database (D1 enforces foreign keys, and an EU database's
-- copies of those tables are empty). The four tables are rebuilt without them. Nothing references
-- these tables and no trigger is defined on them, so a plain rebuild keeps everything else.
-- Signing out no longer deletes the rows by cascade: redeeming and renewing check the session in
-- the global database, and the expiry prune removes them.
CREATE TABLE `__new_read_handoffs` (
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
	`host` text,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_read_handoffs`("code_hash", "artifact_id", "user_id", "state_hash", "auth_session_id", "policy_generation", "expires_at", "used_at", "session_id", "created_at", "host") SELECT "code_hash", "artifact_id", "user_id", "state_hash", "auth_session_id", "policy_generation", "expires_at", "used_at", "session_id", "created_at", "host" FROM `read_handoffs`;--> statement-breakpoint
DROP TABLE `read_handoffs`;--> statement-breakpoint
ALTER TABLE `__new_read_handoffs` RENAME TO `read_handoffs`;--> statement-breakpoint
CREATE INDEX `read_handoffs_expires_idx` ON `read_handoffs` (`expires_at`);--> statement-breakpoint
CREATE INDEX `read_handoffs_auth_session_idx` ON `read_handoffs` (`auth_session_id`);--> statement-breakpoint
CREATE TABLE `__new_read_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`user_id` text NOT NULL,
	`auth_session_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_read_sessions`("id", "artifact_id", "user_id", "auth_session_id", "expires_at", "created_at") SELECT "id", "artifact_id", "user_id", "auth_session_id", "expires_at", "created_at" FROM `read_sessions`;--> statement-breakpoint
DROP TABLE `read_sessions`;--> statement-breakpoint
ALTER TABLE `__new_read_sessions` RENAME TO `read_sessions`;--> statement-breakpoint
CREATE INDEX `read_sessions_expires_idx` ON `read_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `read_sessions_user_idx` ON `read_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `read_sessions_artifact_idx` ON `read_sessions` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `read_sessions_auth_session_idx` ON `read_sessions` (`auth_session_id`);--> statement-breakpoint
CREATE TABLE `__new_review_handoffs` (
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
	`kind` text DEFAULT 'frame' NOT NULL,
	`host` text,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_review_handoffs`("code_hash", "artifact_id", "version_id", "user_id", "auth_session_id", "policy_generation", "expires_at", "used_at", "session_id", "created_at", "kind", "host") SELECT "code_hash", "artifact_id", "version_id", "user_id", "auth_session_id", "policy_generation", "expires_at", "used_at", "session_id", "created_at", "kind", "host" FROM `review_handoffs`;--> statement-breakpoint
DROP TABLE `review_handoffs`;--> statement-breakpoint
ALTER TABLE `__new_review_handoffs` RENAME TO `review_handoffs`;--> statement-breakpoint
CREATE INDEX `review_handoffs_expires_idx` ON `review_handoffs` (`expires_at`);--> statement-breakpoint
CREATE INDEX `review_handoffs_auth_session_idx` ON `review_handoffs` (`auth_session_id`);--> statement-breakpoint
CREATE TABLE `__new_review_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`version_id` text NOT NULL,
	`user_id` text NOT NULL,
	`auth_session_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_review_sessions`("id", "artifact_id", "version_id", "user_id", "auth_session_id", "expires_at", "created_at") SELECT "id", "artifact_id", "version_id", "user_id", "auth_session_id", "expires_at", "created_at" FROM `review_sessions`;--> statement-breakpoint
DROP TABLE `review_sessions`;--> statement-breakpoint
ALTER TABLE `__new_review_sessions` RENAME TO `review_sessions`;--> statement-breakpoint
CREATE INDEX `review_sessions_expires_idx` ON `review_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `review_sessions_user_idx` ON `review_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `review_sessions_artifact_idx` ON `review_sessions` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `review_sessions_auth_session_idx` ON `review_sessions` (`auth_session_id`);