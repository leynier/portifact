// Which database holds each table (decision 0005, "Two-region audit"). Every control database
// gets the same migrations, so every table exists everywhere; this map says which copy is the
// real one. `global` tables are read and written only through a `GlobalDb`, `regional` ones only
// through a region's `RegionalDb`, and `every` tables have one live instance per database (each
// database relays its own outbox, resumes its own scans and records its own idempotent
// operations and audit events). `schema.test.ts` fails when a table is missing here.

export type TableHome = "global" | "regional" | "every";

export const TABLE_HOMES = {
  // Identity (Better Auth, auth-schema.ts).
  users: "global",
  sessions: "global",
  accounts: "global",
  verifications: "global",
  oauth_clients: "global",
  oauth_resources: "global",
  oauth_client_resources: "global",
  oauth_refresh_tokens: "global",
  oauth_access_tokens: "global",
  oauth_consents: "global",
  oauth_client_assertions: "global",
  device_codes: "global",
  rate_limits: "global",
  // Accounts, workspaces and what hangs off them.
  account_settings: "global",
  terms_acceptances: "global",
  account_deletions: "global",
  workspaces: "global",
  workspace_members: "global",
  workspace_invitations: "global",
  workspace_domains: "global",
  workspace_removals: "global",
  workspace_sso: "global",
  // SCIM provisioning (decision 0017): identity, next to single sign-on.
  workspace_scim: "global",
  scim_tokens: "global",
  scim_users: "global",
  scim_groups: "global",
  scim_group_members: "global",
  workspace_groups: "global",
  workspace_group_members: "global",
  workspace_deletions: "global",
  service_tokens: "global",
  github_trust_rules: "global",
  github_used_tokens: "global",
  owner_plans: "global",
  // Platform and operator data.
  artifact_directory: "global",
  tombstones: "global",
  abuse_reports: "global",
  platform_budget: "global",
  budget_alerts: "global",
  email_suppressions: "global",
  email_counters: "global",
  domain_claims: "global",
  custom_domains: "global",
  blocked_hostnames: "global",
  // One per database.
  outbox: "every",
  maintenance_cursors: "every",
  operations: "every",
  audit_events: "every",
  // An owner's data, in the owner's region.
  artifacts: "regional",
  artifact_readers: "regional",
  artifact_groups: "regional",
  read_handoffs: "regional",
  read_sessions: "regional",
  share_links: "regional",
  share_handoffs: "regional",
  share_sessions: "regional",
  review_handoffs: "regional",
  review_sessions: "regional",
  versions: "regional",
  source_origins: "regional",
  objects: "regional",
  version_files: "regional",
  upload_sessions: "regional",
  multipart_uploads: "regional",
  multipart_parts: "regional",
  account_usage: "regional",
  usage_events: "regional",
  traffic_counters: "regional",
  storage_findings: "regional",
  lifecycle_events: "regional",
  suspensions: "regional",
  moderation_decisions: "regional",
  moderation_notice_sends: "regional",
  legal_holds: "regional",
  annotation_threads: "regional",
  annotation_messages: "regional",
  annotation_events: "regional",
  annotation_usage: "regional",
  comment_notices: "regional",
  comment_notice_mutes: "regional",
  review_requests: "regional",
  review_reviewers: "regional",
  review_verdicts: "regional",
  review_notices: "regional",
  webhooks: "regional",
  webhook_events: "regional",
  webhook_deliveries: "regional",
  // Issue integrations (decision 0018): an owner's connections and the issues of its threads.
  integration_connections: "regional",
  thread_issues: "regional",
  // Audit streams (decision 0019): with the owner's webhooks; each reads both homes' events.
  audit_streams: "regional",
  audit_stream_deliveries: "regional",
  owner_brands: "regional",
  search_artifacts: "regional",
  search_chunks: "regional",
  search_text: "regional",
} as const satisfies Record<string, TableHome>;

export type TableName = keyof typeof TABLE_HOMES;

const NAMES = Object.keys(TABLE_HOMES) as TableName[];

const IDENTIFIER = String.raw`["\x60]?([a-z_][a-z0-9_]*)["\x60]?`;
/** A table after the keywords that name one, or an identifier that qualifies a column. */
const TABLE_REFERENCE = new RegExp(
  String.raw`\b(?:from|join|into|update|table)\s+${IDENTIFIER}|${IDENTIFIER}\s*\.\s*["\x60]?[a-z_*]`,
  "gi",
);

/**
 * The tables a SQL statement names: after `from`, `join`, `into`, `update` or `table`, or as the
 * qualifier of a column (`"users"."id"`). String literals are dropped first. A column that shares
 * a table's name (`account_settings.comment_notices`) is not a table reference, so it never
 * counts.
 */
export function tablesIn(sql: string): TableName[] {
  const withoutStrings = sql.replace(/'(?:[^']|'')*'/g, "''");
  const found = new Set<TableName>();
  for (const match of withoutStrings.matchAll(TABLE_REFERENCE)) {
    const word = `${match[1] ?? match[2]}`.toLowerCase();
    if ((TABLE_HOMES as Record<string, TableHome>)[word]) found.add(word as TableName);
  }
  return NAMES.filter((name) => found.has(name));
}
