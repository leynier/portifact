// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { setupConsent } from "./consent.ts";
import { messages } from "./messages.ts";
import {
  element,
  type FakeApi,
  type FakeLocation,
  fakeApi,
  fakeLocation,
  loadPage,
  ORIGIN,
  pageEnv,
  session,
  settle,
} from "./test-page.ts";

let api: FakeApi;
let location: FakeLocation;

function consentSearch(values: Record<string, string>, extra = ""): string {
  const params = new URLSearchParams({ ...values, sig: "s1" });
  for (const name of [...Object.keys(values), "ba_param"]) params.append("ba_param", name);
  return `?${params}${extra}`;
}

const MCP_REQUEST = {
  client_id: "dcr-client",
  redirect_uri: "http://127.0.0.1:53111/callback",
  scope: "artifacts:read artifacts:write offline_access",
  resource: `${ORIGIN}/mcp`,
  state: "s",
};

async function open(search: string) {
  location = fakeLocation(search);
  await setupConsent(document, pageEnv(api, location));
}

beforeEach(() => {
  loadPage("consent");
  api = fakeApi();
  api.on("GET", "/get-session", session("ada@example.test"));
  api.on("GET", "/oauth2/public-client?client_id=dcr-client", {
    status: 200,
    body: { client_id: "dcr-client", client_name: "Example <b>MCP</b> client" },
  });
  api.on("POST", "/oauth2/consent", (body) => ({
    status: 200,
    body: {
      redirect: true,
      url: (body as { accept: boolean }).accept
        ? "http://127.0.0.1:53111/callback?code=c&state=s"
        : "http://127.0.0.1:53111/callback?error=access_denied&state=s",
    },
  }));
});

describe("consent page", () => {
  it("shows the client, resource, scopes, return host and a loopback warning", async () => {
    await open(consentSearch(MCP_REQUEST));
    expect(element("request").hidden).toBe(false);
    // Client-supplied text is shown as text, never parsed as HTML.
    expect(element("client-name").textContent).toBe("Example <b>MCP</b> client");
    expect(element("client-name").querySelector("b")).toBeNull();
    expect(element("resource").textContent).toBe("Portifact MCP");
    expect([...element("scopes").querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "See your artifacts, their settings and their versions",
      "Publish and update artifacts",
      "Stay connected until you revoke access",
    ]);
    expect(element("redirect").textContent).toBe(messages.redirectHost("127.0.0.1:53111"));
    expect(element("loopback-warning").hidden).toBe(false);
    expect(element("client-domain-row").hidden).toBe(true);
    expect(element("signed-in-email").textContent).toBe(messages.signedInAs("ada@example.test"));
  });

  it("sends the signed request back on allow and follows the client's callback", async () => {
    const search = consentSearch(MCP_REQUEST, "&unsigned=1");
    await open(search);
    element("allow").click();
    await settle();
    const call = api.calls.at(-1);
    expect(call?.path).toBe("/oauth2/consent");
    expect(call?.body).toMatchObject({ accept: true });
    const { oauth_query: oauthQuery } = (call?.body ?? {}) as { oauth_query?: string };
    const sent = new URLSearchParams(oauthQuery);
    expect(sent.get("client_id")).toBe("dcr-client");
    expect(sent.has("unsigned")).toBe(false);
    expect(location.assigned).toEqual(["http://127.0.0.1:53111/callback?code=c&state=s"]);
  });

  it("sends a denial and follows the client's callback", async () => {
    await open(consentSearch(MCP_REQUEST));
    element("deny").click();
    await settle();
    expect(api.calls.at(-1)?.body).toMatchObject({ accept: false });
    expect(location.assigned).toEqual([
      "http://127.0.0.1:53111/callback?error=access_denied&state=s",
    ]);
  });

  it("names the domain that publishes a client metadata document", async () => {
    const clientId = "https://claude.ai/oauth/claude-code-client-metadata";
    api.on("GET", `/oauth2/public-client?${new URLSearchParams({ client_id: clientId })}`, {
      status: 200,
      body: { client_id: clientId, client_name: "Claude Code" },
    });
    await open(
      consentSearch({
        ...MCP_REQUEST,
        client_id: clientId,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      }),
    );
    expect(element("client-name").textContent).toBe("Claude Code");
    expect(element("client-domain").textContent).toBe("claude.ai");
    expect(element("client-domain-row").hidden).toBe(false);
    expect(element("redirect").textContent).toBe(messages.redirectHost("claude.ai"));
    expect(element("loopback-warning").hidden).toBe(true);
  });

  it("falls back to the client ID and hides missing details", async () => {
    api.on("GET", "/oauth2/public-client?client_id=dcr-client", {
      status: 200,
      body: { client_id: "dcr-client" },
    });
    await open(consentSearch({ client_id: "dcr-client", redirect_uri: "not a url" }));
    expect(element("client-name").textContent).toBe("dcr-client");
    expect(element("resource-row").hidden).toBe(true);
    expect(element("redirect").textContent).toBe("");
    expect(element("scopes").children).toHaveLength(0);
  });

  it("refuses to render without a signed authorization request", async () => {
    await open("?client_id=dcr-client");
    expect(element("error-summary").textContent).toBe(messages.consentMissing);
    expect(element("request").hidden).toBe(true);
    loadPage("consent");
    await open(consentSearch({ scope: "artifacts:read" }));
    expect(element("error-summary").textContent).toBe(messages.consentMissing);
  });

  it("does not trust a repeated client_id", async () => {
    await open(
      consentSearch(MCP_REQUEST).replace(
        "client_id=dcr-client",
        "client_id=dcr-client&client_id=other",
      ),
    );
    expect(element("error-summary").textContent).toBe(messages.consentMissing);
  });

  it("sends a visitor without a session to sign in with the same request", async () => {
    api.on("GET", "/get-session", { status: 200, body: null });
    const search = consentSearch(MCP_REQUEST);
    await open(search);
    expect(location.assigned).toEqual([`/login${search}`]);
  });

  it("explains an unknown or disabled client and offers no decision", async () => {
    api.on("GET", "/oauth2/public-client?client_id=dcr-client", { status: 404, body: null });
    await open(consentSearch(MCP_REQUEST));
    expect(element("error-summary").textContent).toBe(messages.consentClientUnknown);
    expect(element("request").hidden).toBe(true);
  });

  it("explains when Portifact cannot be reached", async () => {
    api.on("GET", "/oauth2/public-client?client_id=dcr-client", { status: 0, body: null });
    await open(consentSearch(MCP_REQUEST));
    expect(element("error-summary").textContent).toBe(messages.network);
  });

  it("reports a decision that failed", async () => {
    api.on("POST", "/oauth2/consent", { status: 400, body: { error: "invalid_signature" } });
    await open(consentSearch(MCP_REQUEST));
    element("allow").click();
    await settle();
    expect(element("error-summary").textContent).toBe(messages.unexpected);
    expect(location.assigned).toEqual([]);

    api.on("POST", "/oauth2/consent", { status: 0, body: null });
    element("allow").click();
    await settle();
    expect(element("error-summary").textContent).toBe(messages.network);
  });
});
