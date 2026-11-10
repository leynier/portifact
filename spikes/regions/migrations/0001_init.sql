-- Spike S4. A reduced copy of the tables the cross-database operations touch. The same history
-- is applied to the global database and to every regional one (see vitest.config.ts); the code
-- reads and writes each table only through the handle the design assigns it.

-- Global: identity (Better Auth's users and sessions, reduced).
CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL
);
CREATE TABLE `sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `expires_at` integer NOT NULL
);

-- Global: workspaces with their region, chosen at creation and never changed.
CREATE TABLE `organizations` (
  `id` text PRIMARY KEY NOT NULL,
  `region` text NOT NULL
);
CREATE TRIGGER `organizations_region_fixed`
BEFORE UPDATE OF `region` ON `organizations`
WHEN NEW.`region` IS NOT OLD.`region`
BEGIN
  SELECT RAISE(ABORT, 'region_fixed');
END;

-- Global: every artifact ID ever handed out and its region. No personal data. Never deleted, so
-- an ID can never be reused, in any region.
CREATE TABLE `artifact_directory` (
  `id` text PRIMARY KEY NOT NULL,
  `region` text NOT NULL,
  `created_at` integer NOT NULL
);
CREATE TRIGGER `artifact_directory_region_fixed`
BEFORE UPDATE OF `region` ON `artifact_directory`
BEGIN
  SELECT RAISE(ABORT, 'region_fixed');
END;
CREATE TRIGGER `artifact_directory_never_deleted`
BEFORE DELETE ON `artifact_directory`
BEGIN
  SELECT RAISE(ABORT, 'directory_permanent');
END;

-- Global: tombstones and pending account deletions, as today.
CREATE TABLE `tombstones` (
  `kind` text NOT NULL,
  `id` text NOT NULL,
  `deleted_at` integer NOT NULL,
  PRIMARY KEY (`kind`, `id`)
);
CREATE TABLE `account_deletions` (
  `user_id` text PRIMARY KEY NOT NULL,
  `requested_at` integer NOT NULL
);

-- Both: the transactional outbox. Each database has its own and relays it on its own.
CREATE TABLE `outbox` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `topic` text NOT NULL,
  `subject` text NOT NULL,
  `generation` integer,
  `available_at` integer NOT NULL,
  `dispatched_at` integer
);

-- Regional: an owner the region must refuse new data for. It is the regional copy of an
-- `account` tombstone, written in the same batch as the claim of the owner's artifacts, so an
-- upload or a comment still in flight cannot land after the region was checked.
CREATE TABLE `owner_fences` (
  `owner_id` text PRIMARY KEY NOT NULL,
  `fenced_at` integer NOT NULL
);

-- Regional: artifact metadata (reduced).
CREATE TABLE `artifacts` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL,
  `name` text NOT NULL,
  `state` text NOT NULL DEFAULT 'active',
  `lifecycle_generation` integer NOT NULL DEFAULT 1,
  CHECK (length(`id`) = 10)
);
CREATE INDEX `artifacts_owner_idx` ON `artifacts` (`owner_id`, `state`);
CREATE TRIGGER `artifacts_refuse_fenced_owner`
BEFORE INSERT ON `artifacts`
WHEN EXISTS (SELECT 1 FROM `owner_fences` WHERE `owner_id` = NEW.`owner_id`)
BEGIN
  SELECT RAISE(ABORT, 'owner_fenced');
END;

-- Regional: comments (reduced). The author may be anyone, the owner is the artifact's.
CREATE TABLE `annotation_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `artifact_id` text NOT NULL REFERENCES `artifacts`(`id`) ON DELETE CASCADE,
  `owner_id` text NOT NULL,
  `author_id` text NOT NULL,
  `body` text NOT NULL
);
CREATE INDEX `annotation_messages_author_idx` ON `annotation_messages` (`author_id`);
CREATE TRIGGER `annotation_messages_refuse_fenced_author`
BEFORE INSERT ON `annotation_messages`
WHEN EXISTS (SELECT 1 FROM `owner_fences` WHERE `owner_id` = NEW.`author_id`)
BEGIN
  SELECT RAISE(ABORT, 'owner_fenced');
END;

-- Regional: read sessions without foreign keys into the global identity tables. Liveness of the
-- app session is checked against the global database on every redeem and refresh instead.
CREATE TABLE `read_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `artifact_id` text NOT NULL REFERENCES `artifacts`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL,
  `auth_session_id` text NOT NULL,
  `expires_at` integer NOT NULL
);
CREATE INDEX `read_sessions_user_idx` ON `read_sessions` (`user_id`);

-- Today's shape of read sessions, with foreign keys to `users` and `sessions`. Kept only to show
-- that it cannot live in a regional database: the identity rows are not there.
CREATE TABLE `read_sessions_today` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `auth_session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE CASCADE
);

-- Regional: the access log (a separate database in production; one table here).
CREATE TABLE `access_events` (
  `artifact_id` text NOT NULL,
  `user_id` text NOT NULL,
  `owner_id` text NOT NULL,
  `window_start` integer NOT NULL,
  PRIMARY KEY (`artifact_id`, `window_start`, `user_id`)
);
