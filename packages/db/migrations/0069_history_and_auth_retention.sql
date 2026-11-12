ALTER TABLE `suspensions` ADD `target_gone_at` integer;--> statement-breakpoint
CREATE INDEX `suspensions_target_gone_idx` ON `suspensions` (`target_gone_at`) WHERE "suspensions"."target_gone_at" is not null;--> statement-breakpoint
CREATE INDEX `annotation_threads_resolved_by_idx` ON `annotation_threads` (`resolved_by`) WHERE "annotation_threads"."resolved_by" is not null;--> statement-breakpoint
CREATE INDEX `lifecycle_events_purged_at_idx` ON `lifecycle_events` (`at`,`artifact_id`) WHERE "lifecycle_events"."event" = 'purged';--> statement-breakpoint
CREATE INDEX `lifecycle_events_actor_idx` ON `lifecycle_events` (`actor_id`) WHERE "lifecycle_events"."actor_id" is not null;--> statement-breakpoint
CREATE INDEX `usage_events_at_idx` ON `usage_events` (`at`);--> statement-breakpoint
CREATE INDEX `device_codes_expires_at_idx` ON `device_codes` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oauth_access_tokens_expires_at_idx` ON `oauth_access_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oauth_client_assertions_expires_at_idx` ON `oauth_client_assertions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oauth_clients_unowned_created_idx` ON `oauth_clients` (`created_at`) WHERE "oauth_clients"."user_id" is null;--> statement-breakpoint
CREATE INDEX `oauth_refresh_tokens_expires_at_idx` ON `oauth_refresh_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `verifications_expires_at_idx` ON `verifications` (`expires_at`);