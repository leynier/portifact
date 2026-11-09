ALTER TABLE `account_settings` ADD `expiry_notices` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `expiry_notice_for` integer;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `expiry_notice_at` integer;