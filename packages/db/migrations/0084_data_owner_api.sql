CREATE TABLE `data_operations` (
	`actor_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`artifact_id` text NOT NULL,
	`op_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`actor_id`, `idempotency_key`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `data_operations_created_idx` ON `data_operations` (`created_at`);--> statement-breakpoint
CREATE INDEX `data_operations_artifact_idx` ON `data_operations` (`artifact_id`);
--> statement-breakpoint
-- The first-party CLI may also request `data:read` and `data:write` (decision 0026, delivery 5).
-- Registered MCP clients ask for them through REGISTRATION_SCOPES like any product scope;
-- existing tokens gain nothing until a new sign-in.
UPDATE `oauth_clients`
SET `scopes` = '["artifacts:read","artifacts:write","artifacts:share","artifacts:delete","annotations:read","annotations:write","annotations:moderate","data:read","data:write","credentials:manage","offline_access"]',
  `updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
WHERE `client_id` = 'portifact-cli';
