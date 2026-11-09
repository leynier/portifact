CREATE TABLE `account_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`default_access_mode` text DEFAULT 'restricted' NOT NULL,
	`default_annotations` text DEFAULT 'off' NOT NULL,
	`default_comment_visibility` text DEFAULT 'owner' NOT NULL,
	`default_bar` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_settings_access_mode" CHECK("account_settings"."default_access_mode" in ('public', 'authenticated', 'restricted')),
	CONSTRAINT "account_settings_annotations" CHECK("account_settings"."default_annotations" in ('off', 'open')),
	CONSTRAINT "account_settings_comment_visibility" CHECK("account_settings"."default_comment_visibility" in ('owner', 'everyone'))
);
