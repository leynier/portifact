// The name of what an /api/v1 route does, for the routes that stay open while a person's account
// has not accepted the current terms (docs/legal.md, "API and MCP clients"). The names are the
// MCP tools' (or their own, for routes without a tool); whether a name is open is decided only by
// `usableWithoutCurrentTerms` in @portifact/domain, so the API and MCP share one rule. A route not
// listed here has no name and is refused without the current terms (fail closed), unless its
// scope is a read scope. `test/terms-operations.test.ts` classifies every route.
import type { AccountSessionOperation, TermsOpenOperation } from "@portifact/domain";

export const API_TERMS_OPERATIONS: Readonly<Record<string, TermsOpenOperation>> = {
  "GET /api/v1/artifacts/:artifactId/share-links": "list_share_links",
  "DELETE /api/v1/artifacts/:artifactId": "delete_artifact",
  "POST /api/v1/artifacts/:artifactId/archive": "archive_artifact",
  "POST /api/v1/artifacts/:artifactId/unpin": "unpin_artifact",
  "PATCH /api/v1/artifacts/:artifactId/access": "set_access",
  "DELETE /api/v1/artifacts/:artifactId/share-links/:linkId": "revoke_share_link",
  "DELETE /api/v1/domains/:hostname": "remove_custom_domain",
  "DELETE /api/v1/artifacts/:artifactId/annotations/messages/:messageId": "delete_annotation",
  "DELETE /api/v1/artifacts/:artifactId/annotations/threads/:threadId": "delete_thread",
  "DELETE /api/v1/artifacts/:artifactId/review/request": "cancel_review",
  "DELETE /api/v1/publishes/:uploadId": "cancel_upload",
  "DELETE /api/v1/webhooks/:webhookId": "delete_webhook",
  "PATCH /api/v1/webhooks/:webhookId": "update_webhook",
  "DELETE /api/v1/artifacts/:artifactId/data/collections/:collection/documents/:documentId":
    "delete_data_document",
  "POST /api/v1/artifacts/:artifactId/data/collections/:collection/documents/bulk-delete":
    "delete_data_documents",
  "POST /api/v1/artifacts/:artifactId/data/erase": "erase_artifact_data",
  "POST /api/v1/artifacts/:artifactId/data/authors/:author/delete": "delete_author_data",
};

/** The operation a matched route performs, or null when it has none of these names. */
export function apiTermsOperation(method: string, routePath: string): TermsOpenOperation | null {
  return API_TERMS_OPERATIONS[`${method.toUpperCase()} ${routePath}`] ?? null;
}

/**
 * The operation each account route performs (`/api/v1/account`, the dashboard session only),
 * classified by `ACCOUNT_SESSION_OPERATIONS` in @portifact/domain: what a session of an account
 * without the current terms may still do there (docs/legal.md, "Leaving without accepting"). A
 * route missing here is refused to such a session (fail closed), and
 * `test/terms-operations.test.ts` fails until every account route is listed.
 */
export const ACCOUNT_ROUTE_OPERATIONS: Readonly<Record<string, AccountSessionOperation>> = {
  "GET /api/v1/account/sessions": "list_browser_sessions",
  "POST /api/v1/account/sessions/sign-out-others": "sign_out_other_sessions",
  "GET /api/v1/account/apps": "list_connected_apps",
  "DELETE /api/v1/account/apps/:clientId": "disconnect_app",
  "GET /api/v1/account/suspension": "read_account_suspension",
  "GET /api/v1/account/settings": "read_account_settings",
  "PATCH /api/v1/account/settings": "update_account_settings",
  "GET /api/v1/account/comment-notices/:artifactId": "read_comment_notice_mute",
  "PUT /api/v1/account/comment-notices/:artifactId": "set_comment_notice_mute",
  "GET /api/v1/account/branding": "read_branding",
  "PUT /api/v1/account/branding": "update_branding",
  "DELETE /api/v1/account/branding": "delete_branding",
  "GET /api/v1/account/branding/logo": "read_branding_logo",
  "PUT /api/v1/account/branding/logo": "set_branding_logo",
  "DELETE /api/v1/account/branding/logo": "remove_branding_logo",
  "GET /api/v1/account/export": "export_account",
  "POST /api/v1/account/delete": "delete_account",
  "POST /api/v1/account/deletion-code": "request_account_deletion_code",
  "POST /api/v1/account/delete-with-code": "delete_account_with_code",
  "GET /api/v1/account/data-grants": "list_data_grants",
  "GET /api/v1/account/data-grants/:artifactId/control": "read_data_grant_control",
  "POST /api/v1/account/data-grants": "issue_data_grant",
  "DELETE /api/v1/account/data-grants/:artifactId": "revoke_data_grants",
};

/** The operation a matched account route performs, or null when it has no name. */
export function accountRouteOperation(
  method: string,
  routePath: string,
): AccountSessionOperation | null {
  return ACCOUNT_ROUTE_OPERATIONS[`${method.toUpperCase()} ${routePath}`] ?? null;
}
