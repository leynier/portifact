-- The first-party CLI may also request `credentials:manage`, which lists and revokes the
-- account's own tokens through /api/v1/tokens (docs/decisions/0003-credentials-scope.md). Only
-- this client's record lists it; registered MCP clients cannot ask for it.
UPDATE `oauth_clients`
SET `scopes` = '["artifacts:read","artifacts:write","artifacts:share","artifacts:delete","annotations:read","annotations:write","annotations:moderate","credentials:manage","offline_access"]',
  `updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
WHERE `client_id` = 'portifact-cli';
