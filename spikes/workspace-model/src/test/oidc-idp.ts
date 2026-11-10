// A fake OpenID Connect provider behind a replaced global fetch: discovery, token endpoint and
// JWKS, with ID tokens signed by a fresh RS256 key. Only for tests.
import { vi } from "vitest";

export const ISSUER = "https://idp.example.com";

export interface IdTokenClaims {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
}

export interface FakeIdp {
  /** Claims the next code exchange returns, keyed by the code the test hands to the callback. */
  codes: Map<string, IdTokenClaims>;
  fetched: string[];
  /** The authorization request's nonce, if the SP sent one, must come back in the ID token. */
  bindNonce: (code: string, nonce: string | null) => void;
  restore: () => void;
}

function base64Url(bytes: ArrayBuffer | Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...raw))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function startFakeIdp(clientId: string): Promise<FakeIdp> {
  const keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  const kid = "spike-key";
  const codes = new Map<string, IdTokenClaims>();
  const fetched: string[] = [];
  const nonces = new Map<string, string>();

  const sign = async (claims: Record<string, unknown>) => {
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const payload = base64Url(JSON.stringify(claims));
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${base64Url(signature)}`;
  };

  const realFetch = globalThis.fetch;
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== ISSUER) return realFetch(input, init);
    fetched.push(url.pathname);
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      });
    }
    if (url.pathname === "/jwks") {
      return Response.json({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] });
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await request.text());
      const code = form.get("code") ?? "";
      const claims = codes.get(code);
      if (!claims) return Response.json({ error: "invalid_grant" }, { status: 400 });
      codes.delete(code);
      const now = Math.floor(Date.now() / 1000);
      const idToken = await sign({
        iss: ISSUER,
        aud: clientId,
        iat: now,
        exp: now + 300,
        ...(nonces.get(code) ? { nonce: nonces.get(code) } : {}),
        ...claims,
      });
      return Response.json({
        access_token: `at-${code}`,
        token_type: "Bearer",
        expires_in: 300,
        id_token: idToken,
      });
    }
    return new Response("not found", { status: 404 });
  };
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(fake);
  return {
    codes,
    fetched,
    bindNonce: (code, nonce) => {
      if (nonce) nonces.set(code, nonce);
    },
    restore: () => spy.mockRestore(),
  };
}
