-- Restore markers for the identity tables (docs/operations.md, "Restoring a backup"). Better Auth
-- ends sessions, revokes tokens and deletes whole token families through its own adapter, and the
-- dashboard's "Disconnect" deletes tokens and the consent, so the markers are written here, by the
-- statement that changes the row, whatever path changed it: a browser session that ended before
-- it expired (`session`), an OAuth access or refresh token deleted or revoked before it expired
-- (`oauth_token`), and a consent deleted (`oauth_grant`, an app disconnected). `applyTombstones`
-- deletes those sessions and consents again and revokes those tokens; the maintenance run prunes
-- the markers after the Time Travel window. Expired rows write none: a restore cannot make them
-- usable. Rebuilding one of these tables drops its triggers: recreate them in the same migration
-- (packages/db/test/auth-restore-markers.test.ts checks they exist).
CREATE TRIGGER `sessions_restore_marker`
AFTER DELETE ON `sessions`
WHEN OLD.`expires_at` > cast(unixepoch('subsecond') * 1000 as integer)
BEGIN
  INSERT OR IGNORE INTO `tombstones` (`kind`, `id`, `deleted_at`)
  VALUES ('session', OLD.`id`, cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER `oauth_access_tokens_restore_marker_delete`
AFTER DELETE ON `oauth_access_tokens`
WHEN OLD.`revoked` IS NULL AND (OLD.`expires_at` IS NULL OR OLD.`expires_at` > cast(unixepoch('subsecond') * 1000 as integer))
BEGIN
  INSERT OR IGNORE INTO `tombstones` (`kind`, `id`, `deleted_at`)
  VALUES ('oauth_token', OLD.`id`, cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER `oauth_access_tokens_restore_marker_revoke`
AFTER UPDATE OF `revoked` ON `oauth_access_tokens`
WHEN OLD.`revoked` IS NULL AND NEW.`revoked` IS NOT NULL AND (NEW.`expires_at` IS NULL OR NEW.`expires_at` > cast(unixepoch('subsecond') * 1000 as integer))
BEGIN
  INSERT OR IGNORE INTO `tombstones` (`kind`, `id`, `deleted_at`)
  VALUES ('oauth_token', NEW.`id`, cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER `oauth_refresh_tokens_restore_marker_delete`
AFTER DELETE ON `oauth_refresh_tokens`
WHEN OLD.`revoked` IS NULL AND (OLD.`expires_at` IS NULL OR OLD.`expires_at` > cast(unixepoch('subsecond') * 1000 as integer))
BEGIN
  INSERT OR IGNORE INTO `tombstones` (`kind`, `id`, `deleted_at`)
  VALUES ('oauth_token', OLD.`id`, cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER `oauth_refresh_tokens_restore_marker_revoke`
AFTER UPDATE OF `revoked` ON `oauth_refresh_tokens`
WHEN OLD.`revoked` IS NULL AND NEW.`revoked` IS NOT NULL AND (NEW.`expires_at` IS NULL OR NEW.`expires_at` > cast(unixepoch('subsecond') * 1000 as integer))
BEGIN
  INSERT OR IGNORE INTO `tombstones` (`kind`, `id`, `deleted_at`)
  VALUES ('oauth_token', NEW.`id`, cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER `oauth_consents_restore_marker`
AFTER DELETE ON `oauth_consents`
BEGIN
  INSERT OR IGNORE INTO `tombstones` (`kind`, `id`, `deleted_at`)
  VALUES ('oauth_grant', OLD.`id`, cast(unixepoch('subsecond') * 1000 as integer));
END;
