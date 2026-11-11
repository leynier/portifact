ALTER TABLE `artifacts` ADD `life_started_at` integer;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `uncapped_expires_at` integer;--> statement-breakpoint
CREATE INDEX `artifacts_capped_owner_idx` ON `artifacts` (`owner_id`) WHERE "artifacts"."uncapped_expires_at" is not null;