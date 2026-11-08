-- At most two open uploads per account (plan section 2, LIMITS.concurrentUploads), enforced by
-- the database like the slot and storage limits: two prepares that both read one open upload
-- would otherwise both open theirs. SQLite cannot add a CHECK constraint to an existing table,
-- so a trigger refuses any increase past the limit; decreases always pass, so an account that
-- somehow holds more can still close them.
CREATE TRIGGER `account_usage_open_uploads_limit`
BEFORE UPDATE OF `open_uploads` ON `account_usage`
WHEN NEW.`open_uploads` > 2 AND NEW.`open_uploads` > OLD.`open_uploads`
BEGIN
  SELECT RAISE(ABORT, 'account_usage_open_uploads_limit');
END;
