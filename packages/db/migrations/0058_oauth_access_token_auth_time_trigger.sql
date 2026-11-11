-- Decision 0021: every OAuth access token carries when the sign-in it descends from happened, so a
-- workspace's maximum session age can be checked from the token row the introspection already
-- reads. The pinned OAuth provider writes the rows itself and keeps the sign-in time only on the
-- refresh token (`auth_time`), which it copies to every rotation, so a refresh never resets it.
--
-- A refresh token the provider writes without one is the first of a new grant: one through the
-- authorization code always carries the session's sign-in, so this is the device flow (the CLI's
-- `portifact login`), which keeps no session. Its sign-in is the grant itself: the moment the
-- person approved the device, which is when the provider issues the first refresh token.
CREATE TRIGGER `oauth_refresh_tokens_auth_time`
AFTER INSERT ON `oauth_refresh_tokens`
WHEN NEW.`auth_time` IS NULL
BEGIN
  UPDATE `oauth_refresh_tokens`
  SET `auth_time` = coalesce(
    (SELECT `created_at` FROM `sessions` WHERE `id` = NEW.`session_id`),
    NEW.`created_at`
  )
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
-- An access token takes its refresh token's sign-in, or its session's (`created_at`, which Better
-- Auth keeps when it extends a session) when it has no refresh token. When neither says, the
-- column stays null and a policy that needs it refuses: the person signs in again.
CREATE TRIGGER `oauth_access_tokens_auth_time`
AFTER INSERT ON `oauth_access_tokens`
WHEN NEW.`auth_time` IS NULL
BEGIN
  UPDATE `oauth_access_tokens`
  SET `auth_time` = coalesce(
    (SELECT `auth_time` FROM `oauth_refresh_tokens` WHERE `id` = NEW.`refresh_id`),
    (SELECT `created_at` FROM `sessions` WHERE `id` = NEW.`session_id`)
  )
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
-- Grants from before this release: the sign-in of their session when it is still there, and
-- otherwise 0, "not known", which every maximum session age refuses (the person signs in again
-- once), instead of a guess that would make an old grant look recent. Rotation copies it on.
UPDATE `oauth_refresh_tokens`
SET `auth_time` = coalesce(
  (SELECT `created_at` FROM `sessions` WHERE `sessions`.`id` = `oauth_refresh_tokens`.`session_id`),
  0
)
WHERE `auth_time` IS NULL;
--> statement-breakpoint
UPDATE `oauth_access_tokens`
SET `auth_time` = coalesce(
  (SELECT `auth_time` FROM `oauth_refresh_tokens` WHERE `oauth_refresh_tokens`.`id` = `oauth_access_tokens`.`refresh_id`),
  (SELECT `created_at` FROM `sessions` WHERE `sessions`.`id` = `oauth_access_tokens`.`session_id`),
  0
)
WHERE `auth_time` IS NULL;
