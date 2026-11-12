// The grant (decision 0026, "The grant"): a person's consent, given in a control Portifact draws on
// app.portifact.com, that one artifact may know them by an opaque ID and display name and save
// what they enter there. The page never gets an identity any other way. These are the pieces
// that bind the grant to one browser and one artifact host, and the versioned sealing of the
// grant cookie.

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/** A new opaque visitor ID: random, stored with the grant; nothing derives it from an account. */
export function newVisitorId(): string {
  return `v_${randomToken(16)}`;
}

/** A pending grant: the code's hash, the transaction nonce's hash, the artifact host, the expiry. */
export interface PendingGrant {
  codeHash: string;
  nonceHash: string;
  host: string;
  grantId: string;
  expiresAt: number;
  used: boolean;
}

/**
 * Step 1 on the artifact origin: a random nonce, kept by this browser in a sealed, host-only
 * transaction cookie (partitioned under the viewer in the frame flow). Its hash goes to the app.
 */
export async function beginTransaction(): Promise<{ nonce: string; nonceHash: string }> {
  const nonce = randomToken();
  return { nonce, nonceHash: await sha256(nonce) };
}

/** Step 2 on the app, after the person chose "Allow": a one-use code bound to the nonce and host. */
export async function issueCode(
  nonceHash: string,
  host: string,
  grantId: string,
  now: number,
): Promise<{ code: string; pending: PendingGrant }> {
  const code = randomToken();
  return {
    code,
    pending: {
      codeHash: await sha256(code),
      nonceHash,
      host,
      grantId,
      expiresAt: now + 60_000,
      used: false,
    },
  };
}

export type RedeemResult = { ok: true; grantId: string } | { ok: false };

/**
 * Step 3 on the artifact origin: the code redeems only once, before it expires, on the host it
 * was issued for, and only in the browser whose transaction cookie holds the nonce it was bound
 * to. A code made for someone else (session fixation, finding 3) fails the nonce check.
 */
export async function redeem(
  pending: PendingGrant | undefined,
  code: string,
  txNonce: string | null,
  host: string,
  now: number,
): Promise<RedeemResult> {
  if (pending === undefined || pending.used || pending.expiresAt <= now) return { ok: false };
  if (pending.codeHash !== (await sha256(code))) return { ok: false };
  if (pending.host !== host || txNonce === null) return { ok: false };
  if (pending.nonceHash !== (await sha256(txNonce))) return { ok: false };
  pending.used = true;
  return { ok: true, grantId: pending.grantId };
}

/** Sealing keys by version; the newest seals, every listed one opens (rotation, finding 24). */
export type KeyRing = { current: string; keys: Record<string, string> };

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** `<kid>.<payload>.<mac>`: the spike signs; production seals with AES-GCM like every cookie. */
export async function sealValue(ring: KeyRing, payload: object): Promise<string> {
  const secret = ring.keys[ring.current];
  if (secret === undefined) throw new Error("no current key");
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(`${ring.current}.${body}`),
  );
  return `${ring.current}.${body}.${base64url(new Uint8Array(mac))}`;
}

export async function openValue<T>(ring: KeyRing, value: string): Promise<T | null> {
  const [kid, body, mac] = value.split(".");
  if (kid === undefined || body === undefined || mac === undefined) return null;
  const secret = ring.keys[kid];
  if (secret === undefined) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    fromBase64url(mac),
    encoder.encode(`${kid}.${body}`),
  );
  if (!valid) return null;
  return JSON.parse(new TextDecoder().decode(fromBase64url(body))) as T;
}

/** What the grant cookie's claims hold: no account ID, no email. */
export interface GrantClaims {
  grant: string;
  artifact: string;
  visitor: string;
  /** Claims expire 60 seconds after issue; the Worker renews them against the grant row. */
  claimsUntil: number;
  /** The grant itself: at most 30 days, and never past the app session it came from. */
  grantUntil: number;
}

/** The deadline a live connection may hold: the claims' own, never longer. */
export function socketDeadline(claims: GrantClaims, now: number): number {
  return Math.min(claims.claimsUntil, claims.grantUntil, now + 60_000);
}
