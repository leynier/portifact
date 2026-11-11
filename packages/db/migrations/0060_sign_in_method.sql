ALTER TABLE `device_codes` ADD `approver_sign_in_method` text;--> statement-breakpoint
ALTER TABLE `oauth_access_tokens` ADD `sign_in_method` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_tokens` ADD `sign_in_method` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `sign_in_method` text;--> statement-breakpoint
-- Decision 0021, "SSO required": every OAuth token carries how the sign-in it descends from
-- happened, so "SSO required" is checked from the token row the introspection already reads, as
-- `auth_time` is. The pinned provider writes the rows itself and knows nothing of the method.
--
-- A refresh token takes the method of the token it rotates: the provider revokes the old token
-- (setting `rotated_at`) right before it inserts the new one with the same `created_at`, user,
-- client, authorization code and `auth_time`, and names nothing else that links them. Only when
-- every such predecessor agrees is its method copied, so a coincidence can never mix two grants'
-- methods: it reads as not known (fail closed). The first refresh token of a grant takes its
-- session's method; a device grant has none and the app writes the approving session's at the
-- exchange (`apps/app/src/auth/device.ts`).
CREATE TRIGGER `oauth_refresh_tokens_sign_in_method`
AFTER INSERT ON `oauth_refresh_tokens`
WHEN NEW.`sign_in_method` IS NULL
BEGIN
  UPDATE `oauth_refresh_tokens`
  SET `sign_in_method` = coalesce(
    (
      SELECT CASE WHEN count(DISTINCT coalesce(`p`.`sign_in_method`, '')) = 1 THEN max(`p`.`sign_in_method`) END
      FROM `oauth_refresh_tokens` `p`
      WHERE `p`.`id` <> NEW.`id`
        AND `p`.`user_id` = NEW.`user_id`
        AND `p`.`client_id` = NEW.`client_id`
        AND `p`.`rotated_at` = NEW.`created_at`
        AND `p`.`auth_time` IS NEW.`auth_time`
        AND `p`.`authorization_code_id` IS NEW.`authorization_code_id`
    ),
    (SELECT `sign_in_method` FROM `sessions` WHERE `id` = NEW.`session_id`)
  )
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
-- An access token takes its refresh token's method, or its session's when it has none (the
-- provider writes the refresh token first). When neither says, it stays null: not known.
CREATE TRIGGER `oauth_access_tokens_sign_in_method`
AFTER INSERT ON `oauth_access_tokens`
WHEN NEW.`sign_in_method` IS NULL
BEGIN
  UPDATE `oauth_access_tokens`
  SET `sign_in_method` = coalesce(
    (SELECT `sign_in_method` FROM `oauth_refresh_tokens` WHERE `id` = NEW.`refresh_id`),
    (SELECT `sign_in_method` FROM `sessions` WHERE `id` = NEW.`session_id`)
  )
  WHERE `id` = NEW.`id`;
END;
