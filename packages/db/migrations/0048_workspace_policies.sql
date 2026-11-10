ALTER TABLE `workspaces` ADD `policy` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `policy_revision` integer DEFAULT 0 NOT NULL;