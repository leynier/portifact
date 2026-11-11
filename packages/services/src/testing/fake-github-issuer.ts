// A fake GitHub Actions OIDC issuer for tests and the e2e stack (decision 0024): never real
// GitHub. It serves a key set at GitHub's real key set URL through a `fetch` the app's
// `githubOidcFetch` takes, and mints ID tokens for a run with WebCrypto (RS256) and its own keys,
// with any claim, header or signature bent by the test. Never imported by a deployed Worker.
import { GITHUB_OIDC_ISSUER, GITHUB_OIDC_JWKS_URL } from "@portifact/contracts";

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

interface SigningKey {
  kid: string;
  pair: CryptoKeyPair;
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
  return { kid: crypto.randomUUID(), pair };
}

/** A workflow run, as GitHub's token describes it. */
export interface FakeGitHubRun {
  repositoryId: string;
  repositoryOwnerId: string;
  repository: string;
  eventName?: string;
  ref?: string;
  environment?: string;
  runId?: string;
  runAttempt?: string;
}

export interface FakeGitHubTokenOptions {
  audience: string | string[];
  /** Merged over the claims; `undefined` removes one. */
  claims?: Record<string, unknown>;
  /** Merged over the header. */
  header?: Record<string, unknown>;
  /** `stray` signs with a key not in the set; `none` sends no signature. */
  signing?: "RS256" | "stray" | "none";
}

export class FakeGitHubIssuer {
  readonly issuer = GITHUB_OIDC_ISSUER;
  readonly jwksUrl = GITHUB_OIDC_JWKS_URL;
  /** The clock the tokens use, so tests can expire them. */
  now: () => number = Date.now;
  /** Answers the key set URL instead, for slow, oversized or failing answers. */
  override: ((url: string) => Promise<Response> | Response | undefined) | null = null;
  /** Every call, by URL (the key set is public). */
  readonly calls: string[] = [];
  private keys: SigningKey[] = [];
  private stray: SigningKey | null = null;

  private async key(): Promise<SigningKey> {
    if (this.keys.length === 0) this.keys.push(await newKey());
    return this.keys[0] as SigningKey;
  }

  /** Replaces the signing key: the old one leaves the key set, as after a rotation. */
  async rotate(): Promise<void> {
    this.keys = [await newKey()];
  }

  /** The `fetch` to give the app as `githubOidcFetch`. */
  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    this.calls.push(url);
    const bent = await this.override?.(url);
    if (bent) return bent;
    if (init.redirect !== "manual")
      throw new Error("the key set must be fetched without redirects");
    if (url !== this.jwksUrl) return new Response("not found", { status: 404 });
    return Response.json(await this.jwks());
  };

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

  /** An ID token for `run` with `options.audience`, as `ACTIONS_ID_TOKEN_REQUEST_URL` answers. */
  async token(run: FakeGitHubRun, options: FakeGitHubTokenOptions): Promise<string> {
    const now = Math.floor(this.now() / 1000);
    const [owner] = run.repository.split("/");
    const eventName = run.eventName ?? "pull_request";
    const ref = run.ref ?? (eventName === "pull_request" ? "refs/pull/7/merge" : "refs/heads/main");
    const payload: Record<string, unknown> = {
      jti: crypto.randomUUID(),
      sub: `repo:${run.repository}:${eventName === "pull_request" ? "pull_request" : `ref:${ref}`}`,
      aud: options.audience,
      ref,
      sha: "0".repeat(40),
      repository: run.repository,
      repository_id: run.repositoryId,
      repository_owner: owner,
      repository_owner_id: run.repositoryOwnerId,
      repository_visibility: "public",
      run_id: run.runId ?? "4242",
      run_number: "3",
      run_attempt: run.runAttempt ?? "1",
      actor: "someone",
      actor_id: "99",
      workflow: "Preview",
      event_name: eventName,
      ref_type: "branch",
      runner_environment: "github-hosted",
      iss: this.issuer,
      nbf: now - 5,
      iat: now - 5,
      exp: now + 300,
      ...(run.environment === undefined ? {} : { environment: run.environment }),
      ...options.claims,
    };
    for (const [field, value] of Object.entries(payload)) {
      if (value === undefined) delete payload[field];
    }
    let key = await this.key();
    if (options.signing === "stray") {
      this.stray ??= await newKey();
      key = this.stray;
    }
    const header = { alg: "RS256", typ: "JWT", kid: key.kid, ...options.header };
    const head = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    if (options.signing === "none") return `${head}.`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key.pair.privateKey,
      encoder.encode(head),
    );
    return `${head}.${base64url(new Uint8Array(signature))}`;
  }
}
