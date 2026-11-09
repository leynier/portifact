ALTER TABLE `artifact_readers` ADD `comment_visibility` text;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `comment_visibility` text DEFAULT 'owner' NOT NULL;