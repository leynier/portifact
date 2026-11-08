CREATE TABLE `multipart_parts` (
	`session_id` text NOT NULL,
	`sha256` text NOT NULL,
	`part_number` integer NOT NULL,
	`etag` text NOT NULL,
	PRIMARY KEY(`session_id`, `sha256`, `part_number`),
	FOREIGN KEY (`session_id`,`sha256`) REFERENCES `multipart_uploads`(`session_id`,`sha256`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `multipart_uploads` (
	`session_id` text NOT NULL,
	`sha256` text NOT NULL,
	`owner_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`upload_id` text NOT NULL,
	`part_size` integer NOT NULL,
	`part_count` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`session_id`, `sha256`),
	FOREIGN KEY (`session_id`) REFERENCES `upload_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "multipart_uploads_plan" CHECK("multipart_uploads"."part_size" > 0 and "multipart_uploads"."part_count" > 0)
);
