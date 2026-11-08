// The consent page: shows which client asks for what, on which resource and where the
// browser returns, then sends the user's decision with the signed authorization request.
// Everything that came from the client is written as text, never as HTML.
import { currentUserEmail, field } from "./api.ts";
import { byId, fillList, hideSummary, showSummary, whileBusy } from "./dom.ts";
import type { PageEnv } from "./login.ts";
import { messages } from "./messages.ts";
import { signedOAuthQuery, singleParam } from "./query.ts";
import { describeResource, describeScopes } from "./scopes.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export async function setupConsent(doc: Document, env: PageEnv): Promise<void> {
  const { api, location } = env;
  const summary = byId(doc, "error-summary");
  const query = signedOAuthQuery(location.search);
  const clientId = query && singleParam(query, "client_id");
  if (!query || !clientId) {
    showSummary(summary, messages.consentMissing);
    return;
  }

  const email = await currentUserEmail(api);
  if (!email) {
    // Signing in with the same signed request resumes the authorization.
    location.assign(`/login${location.search}`);
    return;
  }

  const client = await api.get(
    `/oauth2/public-client?${new URLSearchParams({ client_id: clientId })}`,
  );
  if (client.status !== 200) {
    showSummary(summary, client.status === 0 ? messages.network : messages.consentClientUnknown);
    return;
  }

  byId(doc, "client-name").textContent = field(client.body, "client_name") ?? clientId;
  byId(doc, "signed-in-email").textContent = messages.signedInAs(email);
  const metadataHost = httpsHost(clientId);
  if (metadataHost) {
    byId(doc, "client-domain").textContent = metadataHost;
    byId(doc, "client-domain-row").hidden = false;
  }
  const redirectUri = singleParam(query, "redirect_uri");
  const redirectHost = redirectUri ? hostOf(redirectUri) : undefined;
  if (redirectHost) {
    byId(doc, "redirect").textContent = messages.redirectHost(redirectHost);
    byId(doc, "loopback-warning").hidden = !LOOPBACK_HOSTS.has(redirectHost.replace(/:\d+$/, ""));
  }
  const resource = singleParam(query, "resource");
  byId(doc, "resource").textContent = resource ? describeResource(resource, env.origin) : "";
  byId(doc, "resource-row").hidden = !resource;
  fillList(byId(doc, "scopes"), describeScopes(singleParam(query, "scope") ?? ""));
  byId(doc, "request").hidden = false;

  const decide = (accept: boolean) => async (event: Event) => {
    hideSummary(summary);
    const button = event.currentTarget as HTMLButtonElement;
    const response = await whileBusy(button, () =>
      api.post("/oauth2/consent", { accept, oauth_query: query }),
    );
    const url = field(response.body, "url");
    if (response.status === 200 && url) {
      location.assign(url);
      return;
    }
    showSummary(summary, response.status === 0 ? messages.network : messages.unexpected);
  };
  byId(doc, "allow").addEventListener("click", decide(true));
  byId(doc, "deny").addEventListener("click", decide(false));
}

/** The host of a Client ID Metadata Document URL, or undefined for an opaque client_id. */
function httpsHost(clientId: string): string | undefined {
  if (!clientId.startsWith("https://")) return undefined;
  return hostOf(clientId);
}

function hostOf(value: string): string | undefined {
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}
