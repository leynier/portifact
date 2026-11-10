CREATE TABLE `owner_brands` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`accent_color` text,
	`link` text,
	`logo_sha256` text,
	`logo_type` text,
	`logo_width` integer,
	`logo_height` integer,
	`logo_bytes` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`suspended_at` integer,
	`suspension_reason` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "owner_brands_accent" CHECK("owner_brands"."accent_color" is null or (length("owner_brands"."accent_color") = 7 and "owner_brands"."accent_color" glob '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "owner_brands_logo" CHECK(("owner_brands"."logo_sha256" is null and "owner_brands"."logo_type" is null and "owner_brands"."logo_width" is null and "owner_brands"."logo_height" is null and "owner_brands"."logo_bytes" is null) or (length("owner_brands"."logo_sha256") = 64 and "owner_brands"."logo_type" in ('image/png', 'image/jpeg', 'image/webp') and "owner_brands"."logo_width" > 0 and "owner_brands"."logo_height" > 0 and "owner_brands"."logo_bytes" between 1 and 100000)),
	CONSTRAINT "owner_brands_suspension" CHECK(("owner_brands"."suspended_at" is null) = ("owner_brands"."suspension_reason" is null))
);
