-- Artifact data's owner document API (decision 0026, delivery 5): the first-party CLI may also
-- request `data:read` and `data:write`. Registered MCP clients ask for them through
-- REGISTRATION_SCOPES like any product scope; existing tokens gain nothing until a new sign-in.
UPDATE `oauth_clients`
SET `scopes` = '["artifacts:read","artifacts:write","artifacts:share","artifacts:delete","annotations:read","annotations:write","annotations:moderate","data:read","data:write","credentials:manage","offline_access"]',
  `updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
WHERE `client_id` = 'portifact-cli';
