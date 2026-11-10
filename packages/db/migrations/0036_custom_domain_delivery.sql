CREATE TABLE `blocked_hostnames` (
	`name` text PRIMARY KEY NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `custom_domains` ADD `notice_for` integer;--> statement-breakpoint
ALTER TABLE `read_handoffs` ADD `host` text;--> statement-breakpoint
ALTER TABLE `review_handoffs` ADD `host` text;--> statement-breakpoint
ALTER TABLE `share_handoffs` ADD `host` text;