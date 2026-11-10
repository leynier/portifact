// The workspace identity provider of the e2e stack (decision 0016): the services' fake OpenID
// Connect provider at IDP_ISSUER. The app Worker reaches its discovery, keys and token endpoint
// through `ssoFetch`, in memory; the browser reaches its authorize page through the stack's
// proxy, which this module answers by sending the browser straight back with a code for the
// identity a test chose on the control host. Nothing leaves the machine.
import { type FakeIdentity, FakeIdentityProvider } from "@portifact/services/testing";
import { IDP_ISSUER } from "../src/hosts.ts";

export const e2eIdp = new FakeIdentityProvider(IDP_ISSUER);

let identity: FakeIdentity | null = null;

/** Who signs in at the provider next (the control host's `/sso-identity`). */
export function setNextIdentity(next: FakeIdentity): void {
  identity = next;
}

/** The provider's pages a browser opens: only `/authorize`, which signs the chosen person in. */
export function idpPage(request: Request): Response {
  const url = new URL(request.url);
  if (url.pathname !== "/authorize" || identity === null) {
    return new Response("Not found", { status: 404 });
  }
  return Response.redirect(e2eIdp.authorize(url.toString(), identity), 302);
}
