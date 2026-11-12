-- The history of accepted terms (docs/legal.md, "Acceptance at sign-in"). An account is created
-- by Better Auth's own insert, with the version and time its acceptance cookie held (the
-- `user.create.before` hook in apps/app/src/auth/terms.ts): this trigger records that acceptance
-- in the same statement, so an account never exists without its first acceptance on record.
-- Later acceptances are recorded by the batch that updates `users` (`recordTermsAcceptance`).
-- Rebuilding `users` drops this trigger: recreate it in the same migration
-- (packages/db/test/terms-acceptances.test.ts checks it exists).
CREATE TRIGGER `terms_acceptances_sign_up`
AFTER INSERT ON `users`
WHEN NEW.`terms_version` IS NOT NULL AND NEW.`terms_accepted_at` IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO `terms_acceptances` (`user_id`, `version`, `accepted_at`, `action`)
  VALUES (NEW.`id`, NEW.`terms_version`, NEW.`terms_accepted_at`, 'sign_up');
END;
--> statement-breakpoint
-- Accounts that accepted before the history existed keep the acceptance they hold, marked
-- `backfill` because how it was given was not recorded.
INSERT OR IGNORE INTO `terms_acceptances` (`user_id`, `version`, `accepted_at`, `action`)
SELECT `id`, `terms_version`, `terms_accepted_at`, 'backfill'
FROM `users`
WHERE `terms_version` IS NOT NULL AND `terms_accepted_at` IS NOT NULL;
