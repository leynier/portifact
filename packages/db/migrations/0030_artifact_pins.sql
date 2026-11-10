ALTER TABLE `artifacts` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `artifacts_pinned_owner_idx` ON `artifacts` (`owner_id`) WHERE "artifacts"."pinned" = 1;