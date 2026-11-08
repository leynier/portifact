// External boundaries of the authorization server. Tests replace them with fakes.

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AuthDeps {
  // Delivers a one-time sign-in code. Never log the code.
  sendOtp: (email: string, otp: string) => Promise<void>;
  // Fetches Client ID Metadata Documents for MCP clients that use a URL as client_id.
  fetchClientMetadata: FetchLike;
}

// Fetch transport for Client ID Metadata Documents on Workers. The Worker runs with the
// global_fetch_strictly_public compatibility flag, so fetch() cannot reach private or
// internal addresses. Redirects are refused, because a document must be served at the
// exact client_id URL, and only HTTPS is allowed.
export function createClientMetadataFetch(fetchImpl: FetchLike): FetchLike {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.protocol !== "https:") {
      throw new Error("client metadata must be served over https");
    }
    const response = await fetchImpl(url, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("client metadata redirects are not followed");
    }
    return response;
  };
}

export function workerDeps(): AuthDeps {
  return {
    sendOtp: async () => {
      // The spike has no email provider. apps/app wires Cloudflare Email Service here.
      throw new Error("email delivery is not configured in the spike");
    },
    fetchClientMetadata: createClientMetadataFetch(fetch),
  };
}
