// A fake OpenID Connect identity provider for tests and the e2e stack (decision 0016): never a
// real one. It serves discovery, a key set and a token endpoint at its issuer through a `fetch`
// the app's `ssoFetch` takes, signs ID tokens with WebCrypto (RS256), checks the client's
// credentials, the redirect URI, PKCE (S256) and that a code is used once, and lets a test bend
// any of it: other discovery fields, other claims, `alg: none`, a rotated or unknown key, or any
// answer for a URL. Never imported by a deployed Worker.

/** Who signs in at the fake provider. */
export interface FakeIdentity {
  sub: string;
  email: string;
  name?: string;
}

interface PendingCode {
  identity: FakeIdentity;
  clientId: string;
  redirectUri: string;
  nonce: string | null;
  challenge: string | null;
  claims: Record<string, unknown>;
  used: boolean;
}

interface SigningKey {
  kid: string;
  pair: CryptoKeyPair;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function newKey(): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return { kid: `k${crypto.randomUUID().slice(0, 8)}`, pair };
}

export class FakeIdentityProvider {
  readonly issuer: string;
  clientId = "portifact-client";
  clientSecret = "fake-client-secret";
  /** Fields merged into the discovery document (undefined removes one). */
  discovery: Record<string, unknown> = {};
  /** `RS256` signs normally; `none` sends an unsigned token; `unknown` signs with a key not in the set. */
  signing: "RS256" | "none" | "unknown" = "RS256";
  /** Answers a URL instead of the provider, for slow, oversized or failing answers. */
  override: ((url: string, init: RequestInit) => Promise<Response> | Response | undefined) | null =
    null;
  /** Every call, by method and URL path (never bodies). */
  readonly calls: { method: string; path: string }[] = [];
  private keys: SigningKey[] = [];
  private stray: SigningKey | null = null;
  private codes = new Map<string, PendingCode>();
  /** The clock the tokens use, so tests can expire them. */
  now: () => number = Date.now;

  constructor(issuer: string) {
    this.issuer = issuer;
  }

  private async key(): Promise<SigningKey> {
    if (this.keys.length === 0) this.keys.push(await newKey());
    return this.keys[0] as SigningKey;
  }

  /** Replaces the signing key: the old one leaves the key set, as after a rotation. */
  async rotate(): Promise<void> {
    this.keys = [await newKey()];
  }

  /** Reads the authorize URL the app sent the browser to, and returns where the provider sends it back. */
  authorize(
    authorizeUrl: string,
    identity: FakeIdentity,
    claims: Record<string, unknown> = {},
  ): string {
    const url = new URL(authorizeUrl);
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const code = crypto.randomUUID();
    this.codes.set(code, {
      identity,
      clientId: url.searchParams.get("client_id") ?? "",
      redirectUri,
      nonce: url.searchParams.get("nonce"),
      challenge: url.searchParams.get("code_challenge"),
      claims,
      used: false,
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    return back.toString();
  }

  /** The `fetch` to give the app as `ssoFetch`. */
  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (init.method ?? "GET").toUpperCase();
    this.calls.push({ method, path: url.pathname });
    const overridden = await this.override?.(url.toString(), init);
    if (overridden) return overridden;
    if (!url.toString().startsWith(this.issuer)) {
      return new Response("unknown host", { status: 404 });
    }
    const path = url.toString().slice(this.issuer.length);
    if (path === "/.well-known/openid-configuration") return Response.json(this.document());
    if (path === "/keys") return Response.json(await this.jwks());
    if (path === "/token" && method === "POST") return this.token(init);
    return new Response("not found", { status: 404 });
  };

  document(): Record<string, unknown> {
    const doc: Record<string, unknown> = {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      jwks_uri: `${this.issuer}/keys`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["RS256"],
      subject_types_supported: ["public"],
    };
    for (const [field, value] of Object.entries(this.discovery)) {
      if (value === undefined) delete doc[field];
      else doc[field] = value;
    }
    return doc;
  }

  private async jwks() {
    await this.key();
    return {
      keys: await Promise.all(
        this.keys.map(async (k) => ({
          ...(await crypto.subtle.exportKey("jwk", k.pair.publicKey)),
          kid: k.kid,
          use: "sig",
          alg: "RS256",
        })),
      ),
    };
  }

  private async token(init: RequestInit): Promise<Response> {
    const refuse = (error: string) => Response.json({ error }, { status: 400 });
    const form = new URLSearchParams(String(init.body ?? ""));
    const auth = new Headers(init.headers).get("authorization") ?? "";
    const expected = `Basic ${btoa(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`)}`;
    if (auth !== expected) return Response.json({ error: "invalid_client" }, { status: 401 });
    if (form.get("grant_type") !== "authorization_code") return refuse("unsupported_grant_type");
    const code = this.codes.get(form.get("code") ?? "");
    if (!code || code.used) return refuse("invalid_grant");
    code.used = true;
    if (code.redirectUri !== form.get("redirect_uri") || code.clientId !== this.clientId) {
      return refuse("invalid_grant");
    }
    const verifier = form.get("code_verifier") ?? "";
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
    if (code.challenge === null || base64url(digest) !== code.challenge) {
      return refuse("invalid_grant");
    }
    return Response.json({
      access_token: crypto.randomUUID(),
      token_type: "Bearer",
      expires_in: 3600,
      id_token: await this.idToken(code),
    });
  }

  private async idToken(code: PendingCode): Promise<string> {
    const now = Math.floor(this.now() / 1000);
    const payload = {
      iss: this.issuer,
      aud: this.clientId,
      sub: code.identity.sub,
      email: code.identity.email,
      email_verified: true,
      name: code.identity.name ?? "Someone",
      iat: now,
      exp: now + 300,
      ...(code.nonce === null ? {} : { nonce: code.nonce }),
      ...code.claims,
    };
    for (const [field, value] of Object.entries(payload)) {
      if (value === undefined) delete (payload as Record<string, unknown>)[field];
    }
    if (this.signing === "none") {
      return `${base64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64url(JSON.stringify(payload))}.`;
    }
    let key = await this.key();
    if (this.signing === "unknown") {
      this.stray ??= await newKey();
      key = this.stray;
    }
    const head = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid }))}.${base64url(JSON.stringify(payload))}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key.pair.privateKey,
      encoder.encode(head),
    );
    return `${head}.${base64url(new Uint8Array(signature))}`;
  }
}
