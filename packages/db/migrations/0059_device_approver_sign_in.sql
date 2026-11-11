-- Decision 0021, review fix: a device login inherits the sign-in of the session that approved it,
-- as an authorization code inherits its session's. The pinned device flow keeps no session and
-- the poll consumes (deletes) the device code before the provider writes the tokens, with nothing
-- on the tokens that names the code, so no trigger can join a token to its approval. The app
-- writes the approving session's `created_at` here at approval (`apps/app/src/auth/device.ts`)
-- and copies it onto the exact token rows of the grant at the exchange. Codes pending at deploy
-- have none: their tokens read as "not known" and the person approves again.
ALTER TABLE `device_codes` ADD `approver_signed_in_at` integer;
--> statement-breakpoint
-- A refresh token written without a sign-in time and without a session is the first of a device
-- grant. It now starts as 0, "not known", instead of its own creation time (the poll, which any
-- stale session could make look fresh by approving a new code); the app sets the approver's time
-- right after the provider writes it, so a failure there fails closed.
DROP TRIGGER `oauth_refresh_tokens_auth_time`;
--> statement-breakpoint
CREATE TRIGGER `oauth_refresh_tokens_auth_time`
AFTER INSERT ON `oauth_refresh_tokens`
WHEN NEW.`auth_time` IS NULL
BEGIN
  UPDATE `oauth_refresh_tokens`
  SET `auth_time` = coalesce(
    (SELECT `created_at` FROM `sessions` WHERE `id` = NEW.`session_id`),
    0
  )
  WHERE `id` = NEW.`id`;
END;
