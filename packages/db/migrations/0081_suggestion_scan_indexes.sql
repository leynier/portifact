DROP INDEX `change_items_closed_idx`;--> statement-breakpoint
CREATE INDEX `change_items_closed_key_idx` ON `change_items` (`closed_at`,`id`) WHERE "change_items"."closed_at" is not null;--> statement-breakpoint
DROP INDEX `edit_drafts_updated_idx`;--> statement-breakpoint
CREATE INDEX `edit_drafts_unused_idx` ON `edit_drafts` (`updated_at`,`artifact_id`,`user_id`) WHERE "edit_drafts"."attempt_id" is null;--> statement-breakpoint
CREATE INDEX `acceptance_attempts_running_created_idx` ON `acceptance_attempts` (`created_at`) WHERE "acceptance_attempts"."state" = 'running';--> statement-breakpoint
CREATE INDEX `acceptance_attempts_running_deliveries_idx` ON `acceptance_attempts` (`deliveries`) WHERE "acceptance_attempts"."state" = 'running';--> statement-breakpoint
CREATE INDEX `acceptance_attempts_finished_created_idx` ON `acceptance_attempts` (`created_at`,`id`) WHERE "acceptance_attempts"."state" <> 'running';