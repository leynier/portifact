// Cookies of artifact origins. Every Portifact cookie here is host-only (`__Host-`), so a
// sibling artifact can neither read nor overwrite it; values are HMAC-signed so the Worker can
// trust their claims without D1. See docs/security.md, "Cookies and sessions".

export const READ_COOKIE = "__Host-pf_read";
export const TRANSACTION_COOKIE = "__Host-pf_read_tx";

/** Larger values are never ours: they are ignored instead of parsed. */
const MAX_VALUE_LENGTH = 2_048;
const MIN_SECRET_LENGTH = 32;

/**
 * The value of `name` when the Cookie header carries it exactly once. Names match exactly and
 * case-sensitively: WebKit lets a sibling set `__host-…` with a Domain, and two values of one
 * name mean something injected a second cookie, so neither is trusted.
 */
export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  const values: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) values.push(part.slice(separator + 1).trim());
  }
  const [value] = values;
  return values.length === 1 && value && value.length <= MAX_VALUE_LENGTH ? value : null;
}

export interface CookieOptions {
  maxAgeSeconds: number;
}

/** `Set-Cookie` for a host-only cookie: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. */
export function setCookie(name: string, value: string, { maxAgeSeconds }: CookieOptions): string {
  return `${name}=${value}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearCookie(name: string): string {
  return setCookie(name, "", { maxAgeSeconds: 0 });
}

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

/** Whether the signing secret is configured; without it protected artifacts stay closed. */
export function usableSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keys.set(secret, key);
  }
  return key;
}

/**
 * `<base64url JSON>.<base64url HMAC>`. The purpose is part of the signed input, so a value
 * signed as one cookie is never accepted as another.
 */
export async function seal(secret: string, purpose: string, payload: unknown): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(`${purpose}.${body}`),
  );
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/** The payload of a sealed value, or null when it is malformed or its signature is wrong. */
export async function unseal(secret: string, purpose: string, value: string): Promise<unknown> {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];
  const signatureBytes = fromBase64Url(signature);
  const bodyBytes = fromBase64Url(body);
  if (!signatureBytes || !bodyBytes) return null;
  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signatureBytes,
    encoder.encode(`${purpose}.${body}`),
  );
  if (!valid) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return null;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}
