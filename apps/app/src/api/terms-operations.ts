// The name of what an /api/v1 route does, for the routes that stay open while a person's account
// has not accepted the current terms (docs/legal.md, "API and MCP clients"). The names are the
// MCP tools' (or their own, for routes without a tool); whether a name is open is decided only by
// `usableWithoutCurrentTerms` in @portifact/domain, so the API and MCP share one rule. A route not
// listed here has no name and is refused without the current terms (fail closed), unless its
// scope is a read scope. `test/terms-operations.test.ts` classifies every route.
import type { TermsOpenOperation } from "@portifact/domain";

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
};

/** The operation a matched route performs, or null when it has none of these names. */
export function apiTermsOperation(method: string, routePath: string): TermsOpenOperation | null {
  return API_TERMS_OPERATIONS[`${method.toUpperCase()} ${routePath}`] ?? null;
}
