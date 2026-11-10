CREATE TABLE `workspace_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`domain` text NOT NULL,
	`display` text,
	`token` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`verified_at` integer,
	`checked_at` integer,
	`failed_checks` integer DEFAULT 0 NOT NULL,
	`problem` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_domains_state" CHECK("workspace_domains"."state" in ('pending', 'verified'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_domains_workspace_domain_idx` ON `workspace_domains` (`workspace_id`,`domain`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_domains_verified_idx` ON `workspace_domains` (`domain`) WHERE "workspace_domains"."state" = 'verified';--> statement-breakpoint
CREATE INDEX `workspace_domains_state_checked_idx` ON `workspace_domains` (`state`,`checked_at`);