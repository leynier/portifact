-- Protected resources and the first-party CLI client (docs/decisions/0001-oauth-server.md).
-- The resources are also seeded by Better Auth at startup; inserting them here first lets the
-- CLI client link to the API without depending on a running Worker. The CLI is a public
-- client (no secret) that only uses the device grant and refresh tokens, and is linked to the
-- API resource only, so it cannot obtain MCP tokens. Its redirect URI is never used: the
-- schema requires one.
INSERT OR IGNORE INTO `oauth_resources` (`id`, `identifier`, `name`, `dpop_bound_access_tokens_required`, `disabled`, `policy_version`, `created_at`, `updated_at`)
VALUES
  ('portifact-api', 'https://app.portifact.com/api/v1', 'Portifact API', 0, 0, 1, cast(unixepoch('subsecond') * 1000 as integer), cast(unixepoch('subsecond') * 1000 as integer)),
  ('portifact-mcp', 'https://app.portifact.com/mcp', 'Portifact MCP', 0, 0, 1, cast(unixepoch('subsecond') * 1000 as integer), cast(unixepoch('subsecond') * 1000 as integer));
--> statement-breakpoint
INSERT INTO `oauth_clients` (`id`, `client_id`, `name`, `disabled`, `scopes`, `client_credentials_scopes`, `redirect_uris`, `token_endpoint_auth_method`, `application_type`, `grant_types`, `require_pkce`, `dpop_bound_access_tokens`, `created_at`, `updated_at`)
VALUES ('portifact-cli', 'portifact-cli', 'Portifact CLI', 0, '["artifacts:read","artifacts:write","artifacts:share","artifacts:delete","annotations:read","annotations:write","annotations:moderate","offline_access"]', '[]', '["http://127.0.0.1/callback"]', 'none', 'native', '["urn:ietf:params:oauth:grant-type:device_code","refresh_token"]', 1, 0, cast(unixepoch('subsecond') * 1000 as integer), cast(unixepoch('subsecond') * 1000 as integer));
--> statement-breakpoint
INSERT INTO `oauth_client_resources` (`id`, `client_id`, `resource_id`, `created_at`)
VALUES ('portifact-cli-api', 'portifact-cli', 'https://app.portifact.com/api/v1', cast(unixepoch('subsecond') * 1000 as integer));
