CREATE TABLE `data_own_erasures` (
	`artifact_id` text NOT NULL,
	`visitor_id` text NOT NULL,
	`state` text NOT NULL,
	`write_id` text NOT NULL,
	`documents` integer DEFAULT 0 NOT NULL,
	`edits` integer DEFAULT 0 NOT NULL,
	`requested_at` integer NOT NULL,
	`finished_at` integer,
	PRIMARY KEY(`artifact_id`, `visitor_id`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `data_own_erasures_finished_idx` ON `data_own_erasures` (`state`,`finished_at`);--> statement-breakpoint
CREATE TABLE `data_rights_request_sends` (
	`request_id` text NOT NULL,
	`user_id` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`request_id`, `user_id`),
	FOREIGN KEY (`request_id`) REFERENCES `data_rights_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `data_rights_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`visitor_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`recipients` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`settled_at` integer,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `data_rights_requests_state_idx` ON `data_rights_requests` (`state`,`settled_at`);--> statement-breakpoint
CREATE INDEX `data_rights_requests_artifact_idx` ON `data_rights_requests` (`artifact_id`);