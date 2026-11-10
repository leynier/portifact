// Cookies of artifact origins. Every Portifact cookie here is host-only (`__Host-`), so a
// sibling artifact can neither read nor overwrite it; values are encrypted and authenticated
// (AES-GCM) so the Worker can trust their claims without D1 and nobody else can read them. That
// matters on a custom host, whose DNS the domain owner controls (decision 0006, "Codes on a
// custom host"): a code they receive on a server of theirs gives them a cookie, and its claims
// name the reader. See docs/security.md, "Cookies and sessions".

export const READ_COOKIE = "__Host-pf_read";
/**
 * Sign-in transactions are one cookie each, named after the start of their nonce, so a second
 * tab signing in to the same artifact does not overwrite the first tab's transaction.
 */
export const TRANSACTION_COOKIE_PREFIX = "__Host-pf_read_tx_";
const TRANSACTION_TAG_LENGTH = 16;

export function transactionCookieName(nonce: string): string {
  return `${TRANSACTION_COOKIE_PREFIX}${nonce.slice(0, TRANSACTION_TAG_LENGTH)}`;
}

/** Larger values are never ours: they are ignored instead of parsed, and never set. */
export const MAX_VALUE_LENGTH = 2_048;
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

/**
 * Every cookie whose name starts with `prefix`, exactly and case-sensitively. `duplicated`
 * holds names the header carries more than once, whose values are not trusted.
 */
export function cookiesWithPrefix(
  header: string | null,
  prefix: string,
): { values: Map<string, string>; duplicated: Set<string> } {
  const values = new Map<string, string>();
  const duplicated = new Set<string>();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (!name.startsWith(prefix)) continue;
    if (values.has(name) || duplicated.has(name)) {
      values.delete(name);
      duplicated.add(name);
      continue;
    }
    values.set(name, part.slice(separator + 1).trim());
  }
  return { values, duplicated };
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

const ENCRYPTED = "e1";
const IV_BYTES = 12;
const aesKeys = new Map<string, Promise<CryptoKey>>();

/** The cookie key, derived from the secret with HKDF, apart from the legacy HMAC key. */
function aesKey(secret: string): Promise<CryptoKey> {
  let key = aesKeys.get(secret);
  if (!key) {
    key = crypto.subtle
      .importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(0),
            info: encoder.encode("portifact artifact-origin cookies v1"),
          },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    aesKeys.set(secret, key);
  }
  return key;
}

/**
 * `e1.<base64url IV>.<base64url ciphertext and tag>`: AES-GCM with a random IV, the purpose as
 * associated data, so a value sealed as one cookie is never accepted as another and its claims
 * are unreadable without the secret.
 */
export async function seal(secret: string, purpose: string, payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
    await aesKey(secret),
    encoder.encode(JSON.stringify(payload)),
  );
  return `${ENCRYPTED}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

/**
 * The payload of a sealed value, or null when it is malformed, altered or sealed for another
 * purpose. Values signed with HMAC before cookies were encrypted (`<base64url JSON>.<base64url
 * HMAC>`) are still read, so sessions open at a deploy keep working; they last at most a read
 * session's lifetime.
 */
export async function unseal(secret: string, purpose: string, value: string): Promise<unknown> {
  const parts = value.split(".");
  if (parts.length === 3 && parts[0] === ENCRYPTED) {
    const iv = fromBase64Url(parts[1] as string);
    const ciphertext = fromBase64Url(parts[2] as string);
    if (!iv || iv.length !== IV_BYTES || !ciphertext) return null;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
        await aesKey(secret),
        ciphertext,
      );
      return JSON.parse(new TextDecoder().decode(plain));
    } catch {
      return null;
    }
  }
  return unsealSigned(secret, purpose, parts);
}

async function unsealSigned(secret: string, purpose: string, parts: string[]): Promise<unknown> {
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
