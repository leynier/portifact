CREATE TABLE `custom_domains` (
	`hostname` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`region` text NOT NULL,
	`state` text NOT NULL,
	`token` text NOT NULL,
	`cf_hostname_id` text,
	`verified_at` integer NOT NULL,
	`checked_at` integer NOT NULL,
	`missed_checks` integer DEFAULT 0 NOT NULL,
	`problem` text,
	`detach_reason` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "custom_domains_state" CHECK("custom_domains"."state" in ('provisioning', 'active', 'detaching'))
);
--> statement-breakpoint
CREATE INDEX `custom_domains_owner_idx` ON `custom_domains` (`owner_id`,`verified_at`);--> statement-breakpoint
CREATE INDEX `custom_domains_artifact_idx` ON `custom_domains` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `custom_domains_check_idx` ON `custom_domains` (`state`,`checked_at`);--> statement-breakpoint
CREATE TABLE `domain_claims` (
	`hostname` text NOT NULL,
	`owner_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`region` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`hostname`, `owner_id`)
);
--> statement-breakpoint
CREATE INDEX `domain_claims_owner_idx` ON `domain_claims` (`owner_id`);--> statement-breakpoint
CREATE INDEX `domain_claims_artifact_idx` ON `domain_claims` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `domain_claims_expires_idx` ON `domain_claims` (`expires_at`);--> statement-breakpoint
ALTER TABLE `artifacts` ADD `custom_host` text;--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_custom_host_idx` ON `artifacts` (`custom_host`) WHERE "artifacts"."custom_host" is not null;