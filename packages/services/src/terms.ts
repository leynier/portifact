// A person acting through an OAuth token whose account has not accepted the current terms may
// still remove and narrow (docs/legal.md, "API and MCP clients"). The adapters let those
// operations through by name (`usableWithoutCurrentTerms`); the services that can either narrow
// or widen check the change itself here, from the credential the request context already holds
// (decision 0021), so the API and MCP get the same answer and no read is added.
import type { GlobalDb } from "@portifact/db";
import { fail, type Result, termsRefusalMessage } from "@portifact/domain";

/**
 * Whether the request acts for a person whose account has not accepted the current terms: an
 * OAuth token that says so, or a request whose credential became unknown (two different ones),
 * which fails closed. Sessions of such accounts never get this far (they count as none), and
 * service tokens and background work are not people.
 */
export function actsWithoutCurrentTerms(global: GlobalDb): boolean {
  const request = global.request;
  if (request.kind !== "request") return false;
  if (request.credential === null) return true;
  const credential = request.credential;
  if (credential?.kind === "oauth") return !credential.termsAccepted;
  return credential?.kind === "session" && credential.termsAccepted === false;
}

/** The refusal of a change that does not only narrow, for such a request. */
export function narrowingOnly(): Result<never> {
  return fail("terms_not_accepted", termsRefusalMessage(null));
}
