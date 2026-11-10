-- Spike S3. The control database, reduced to what the stats read needs: who owns an artifact,
-- its access mode and state, and the owner's plan.
CREATE TABLE `artifacts` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL,
  `access_mode` text NOT NULL,
  `state` text NOT NULL DEFAULT 'active'
);
CREATE INDEX `artifacts_owner_idx` ON `artifacts` (`owner_id`);

CREATE TABLE `owner_plans` (
  `owner_id` text PRIMARY KEY NOT NULL,
  `plan` text NOT NULL
);
