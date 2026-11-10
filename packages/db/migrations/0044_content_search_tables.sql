CREATE TABLE `search_artifacts` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`version_id` text NOT NULL,
	`text_bytes` integer NOT NULL,
	`partial` integer NOT NULL,
	`indexed_at` integer NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `search_artifacts_owner_idx` ON `search_artifacts` (`owner_id`);--> statement-breakpoint
CREATE TABLE `search_chunks` (
	`id` integer PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`path` text NOT NULL,
	`seq` integer NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `search_artifacts`(`artifact_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_chunks_artifact_path_seq_idx` ON `search_chunks` (`artifact_id`,`path`,`seq`);