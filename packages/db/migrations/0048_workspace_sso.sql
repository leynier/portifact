CREATE TABLE `workspace_sso` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_sealed` text NOT NULL,
	`secret_key_id` text NOT NULL,
	`domains` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_sso_workspace_idx` ON `workspace_sso` (`workspace_id`);