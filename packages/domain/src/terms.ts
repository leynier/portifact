import {
  type AccessMode,
  type CommentVisibility,
  type OAuthScope,
  TERMS_VERSION,
} from "@portifact/contracts";

/**
 * Whether an account must accept the terms before it gets a session: it never accepted them,
 * or it accepted a version that is no longer current.
 */
export function needsTermsAcceptance(
  acceptedVersion: string | null | undefined,
  currentVersion: string = TERMS_VERSION,
): boolean {
  return acceptedVersion !== currentVersion;
}

/**
 * What a person's OAuth token (the CLI, MCP clients) may still do while its account has not
 * accepted the current terms (docs/legal.md, "API and MCP clients"): leave and reduce, never act
 * anew. The same reason keeps reads, exports, deletion and access reduction out of the plan and
 * budget gates (AGENTS.md, "Plans" and "Budget protection"): someone who declines new terms, or
 * whose plan or the platform's budget runs out, can always take their data out, unpublish it,
 * narrow who sees it and leave.
 *
 * Every operation of the read scopes stays open: reading and downloading is how a person takes
 * their data out (`portifact export`, `pull`, `annotations export`). It has no time limit and
 * covers everything those scopes reach, access logs and other people's comments on the account's
 * artifacts included; this is deliberate. Every operation of these scopes only reads (`data:read`
 * reads and exports an artifact's documents, decision 0026); a new
 * operation that changes anything must not take one of them.
 */
export const TERMS_EXEMPT_SCOPES: readonly OAuthScope[] = [
  "artifacts:read",
  "annotations:read",
  "data:read",
];

/**
 * The operations of other scopes that stay open, by name (the MCP tool's name; API routes are
 * named after it in `apps/app/src/api/terms-operations.ts`, and routes without a tool get their
 * own name). `read` only reads, `removes` only removes or ends something, and `narrowing` changes
 * a setting that runs only when the change narrows (`accessChangeOnlyNarrows`,
 * `webhookUpdateOnlyNarrows`, applied by the service). Everything that creates, publishes,
 * widens, invites or sends stays refused. `apps/app/test/terms-operations.test.ts` classifies
 * every route and tool, so a new one fails until it is listed there.
 */
export const TERMS_OPEN_OPERATIONS = {
  list_share_links: "read",
  delete_artifact: "removes",
  archive_artifact: "removes",
  unpin_artifact: "removes",
  remove_reader: "removes",
  remove_group: "removes",
  revoke_share_link: "removes",
  remove_custom_domain: "removes",
  delete_annotation: "removes",
  delete_thread: "removes",
  cancel_review: "removes",
  cancel_upload: "removes",
  delete_webhook: "removes",
  delete_data_document: "removes",
  delete_data_documents: "removes",
  set_access: "narrowing",
  set_comment_visibility: "narrowing",
  update_webhook: "narrowing",
} as const satisfies Record<string, "read" | "removes" | "narrowing">;

export type TermsOpenOperation = keyof typeof TERMS_OPEN_OPERATIONS;

/**
 * Whether an operation runs for a person's token without the current terms: one of the read
 * scopes, or an operation `TERMS_OPEN_OPERATIONS` lists. An operation the adapter cannot name is
 * refused (fail closed).
 */
export function usableWithoutCurrentTerms(input: {
  scope: OAuthScope | "credentials:manage";
  operation: string | null;
}): boolean {
  if ((TERMS_EXEMPT_SCOPES as readonly string[]).includes(input.scope)) return true;
  return input.operation !== null && Object.hasOwn(TERMS_OPEN_OPERATIONS, input.operation);
}

/**
 * What a dashboard session of an account without the current terms may do on the account routes
 * (`/api/v1/account`, docs/legal.md, "Leaving without accepting"), by operation name. Every
 * account route is named in `ACCOUNT_ROUTE_OPERATIONS` (apps/app/src/api/terms-operations.ts) and
 * classified here: `read` only reads, `removes` only removes or ends something, `narrowing` runs
 * only when the change narrows (`accountSettingsUpdateOnlyNarrows`,
 * `commentNoticeMuteOnlyNarrows`, applied by the service), `leaving` takes the data out or deletes
 * the account, and `refused` acts anew and waits for the acceptance. A route without a name, or an
 * operation not listed, is refused (fail closed); `apps/app/test/terms-operations.test.ts` fails
 * for an account route that is not named and classified.
 */
export const ACCOUNT_SESSION_OPERATIONS = {
  list_browser_sessions: "read",
  sign_out_other_sessions: "removes",
  list_connected_apps: "read",
  disconnect_app: "removes",
  read_account_suspension: "read",
  read_account_settings: "read",
  update_account_settings: "narrowing",
  read_comment_notice_mute: "read",
  set_comment_notice_mute: "narrowing",
  read_branding: "read",
  update_branding: "refused",
  delete_branding: "removes",
  read_branding_logo: "read",
  set_branding_logo: "refused",
  remove_branding_logo: "removes",
  export_account: "leaving",
  delete_account: "leaving",
  request_account_deletion_code: "leaving",
  delete_account_with_code: "leaving",
  // Grants of artifact data (decision 0026): giving one acts anew, listing and revoking never.
  list_data_grants: "read",
  read_data_grant_control: "read",
  issue_data_grant: "refused",
  revoke_data_grants: "removes",
  export_own_data: "leaving",
  delete_own_document: "removes",
} as const satisfies Record<string, "read" | "removes" | "narrowing" | "leaving" | "refused">;

export type AccountSessionOperation = keyof typeof ACCOUNT_SESSION_OPERATIONS;

/** Whether a session without the current terms may run an account operation (fail closed). */
export function accountSessionUsableWithoutCurrentTerms(operation: string | null): boolean {
  if (operation === null || !Object.hasOwn(ACCOUNT_SESSION_OPERATIONS, operation)) return false;
  return ACCOUNT_SESSION_OPERATIONS[operation as AccountSessionOperation] !== "refused";
}

/** The email notices a settings change may turn off without the current terms. */
const NOTICE_SETTINGS = ["expiryNotices", "commentNotices"] as const;

/**
 * Whether an account settings change only turns email notices off: someone who declines the
 * terms can always stop the emails, and nothing else in the settings changes for them.
 */
export function accountSettingsUpdateOnlyNarrows(update: Record<string, unknown>): boolean {
  const changed = Object.entries(update).filter(([, value]) => value !== undefined);
  return (
    changed.length > 0 &&
    changed.every(
      ([key, value]) => (NOTICE_SETTINGS as readonly string[]).includes(key) && value === false,
    )
  );
}

/** Whether a comment notice change only mutes: unmuting would send email again. */
export function commentNoticeMuteOnlyNarrows(update: { muted: boolean }): boolean {
  return update.muted;
}

/** Who may read an artifact in each mode is a superset of the modes listed for it. */
const NARROWER_MODES: Record<AccessMode, readonly AccessMode[]> = {
  public: ["authenticated", "domain", "workspace", "restricted"],
  authenticated: ["domain", "workspace", "restricted"],
  domain: ["workspace"],
  // A restricted artifact's readers and groups are not members of the workspace, and members
  // are not on the reader list: neither mode is a subset of the other.
  workspace: [],
  restricted: [],
};

/** The parts of an access change `accessChangeOnlyNarrows` reads. */
export interface AccessChangeShape {
  mode?: AccessMode | undefined;
  indexable?: boolean | undefined;
  embeddable?: boolean | undefined;
  bar?: boolean | undefined;
  addReaders?: readonly string[] | undefined;
  removeReaders?: readonly string[] | undefined;
  commentVisibility?: CommentVisibility | undefined;
  readerCommentVisibility?: readonly unknown[] | undefined;
  addGroups?: readonly string[] | undefined;
  removeGroups?: readonly string[] | undefined;
  groupCommentVisibility?: readonly unknown[] | undefined;
}

/**
 * Whether an access change only narrows who can open or find the artifact or read its comments,
 * from its current mode: a mode whose readers are a subset of the current one's, removing readers
 * or groups, turning indexing or embedding off, and comments back to the owner only. Anything
 * else, including the bar and per-reader or per-group comment exceptions, counts as not
 * narrowing. A person without the current terms may only make narrowing changes.
 */
export function accessChangeOnlyNarrows(current: AccessMode, change: AccessChangeShape): boolean {
  if (change.mode !== undefined && change.mode !== current) {
    if (!NARROWER_MODES[current].includes(change.mode)) return false;
  }
  if (change.indexable === true || change.embeddable === true) return false;
  if (change.bar !== undefined) return false;
  if ((change.addReaders?.length ?? 0) > 0 || (change.addGroups?.length ?? 0) > 0) return false;
  if (change.commentVisibility !== undefined && change.commentVisibility !== "owner") return false;
  if ((change.readerCommentVisibility?.length ?? 0) > 0) return false;
  if ((change.groupCommentVisibility?.length ?? 0) > 0) return false;
  return true;
}

/** Whether a webhook change only turns it off: disabling sends nothing and opens nothing. */
export function webhookUpdateOnlyNarrows(update: {
  enabled?: boolean | undefined;
  events?: unknown;
}): boolean {
  return update.enabled === false && update.events === undefined;
}

/**
 * What a person's token is told when the account must accept the current terms first: where to
 * do it (the app's origin when the caller knows it, the dashboard otherwise), that no app or agent
 * can do it for them, what keeps working, and what to do when an older CLI shows it as an
 * unexpected response.
 */
export function termsRefusalMessage(
  appOrigin: string | null,
  version: string = TERMS_VERSION,
): string {
  const where = appOrigin === null ? "the Portifact dashboard" : appOrigin;
  return `This Portifact account has not accepted the current terms (version ${version}). Its holder must open ${where} in a browser, review the terms and select Agree and continue; no app or agent can accept them for the holder. Until then only reading, downloading and removing or narrowing what is shared keep working. If an older Portifact CLI reports this as a response it did not expect, update the CLI or open the dashboard.`;
}

/** What an agent is told on top of the refusal, by MCP (`failure` in apps/app/src/mcp/tools.ts). */
export const TERMS_AGENT_SENTENCE =
  "Ask the user to do it, and do not retry until they say they have.";
