CREATE TABLE `moderation_decision_authors` (
	`decision_id` text NOT NULL,
	`kind` text NOT NULL,
	`author` text NOT NULL,
	PRIMARY KEY(`decision_id`, `kind`, `author`)
);
--> statement-breakpoint
CREATE INDEX `moderation_decision_authors_account_idx` ON `moderation_decision_authors` (`author`) WHERE "moderation_decision_authors"."kind" = 'account';