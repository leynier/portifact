CREATE TABLE `source_origins` (
	`version_id` text PRIMARY KEY NOT NULL,
	`commit` text,
	`branch` text,
	`remote` text,
	`dirty` integer NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "source_origins_commit_format" CHECK("source_origins"."commit" is null or length("source_origins"."commit") in (40, 64)),
	CONSTRAINT "source_origins_branch_length" CHECK("source_origins"."branch" is null or length("source_origins"."branch") <= 255),
	CONSTRAINT "source_origins_remote_length" CHECK("source_origins"."remote" is null or length("source_origins"."remote") <= 2048)
);
