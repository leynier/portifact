// Sealing of single sign-on client secrets (decision 0016): AES-256-GCM under a key derived with
// HKDF from the app Worker's secret `SSO_KEY`, its own key rather than `WEBHOOK_KEY` so the two
// rotate, leak and switch on independently. Each sealed value names the key that sealed it and is
// bound to its workspace and column, so a value copied to another row does not open.

/** `SSO_KEY` and, during a rotation, `SSO_KEY_PREVIOUS`. */
export interface SsoKeySecrets {
  current: string | undefined;
  previous?: string | undefined;
}

export interface SsoKey {
  id: string;
  key: CryptoKey;
}

/** The shortest `SSO_KEY` accepted. */
export const SSO_KEY_MIN_LENGTH = 32;

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(secret: string): Promise<SsoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  const hkdf = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(0),
    info: encoder.encode(info),
  });
  const key = await crypto.subtle.deriveKey(
    hkdf("portifact sso seal v1"),
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const idKey = await crypto.subtle.deriveKey(
    hkdf("portifact sso key id v1"),
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", idKey, encoder.encode("key-id")));
  const id = [...mac.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { id, key };
}

const cache = new Map<string, Promise<SsoKey>>();

/** The keys this Worker holds, current first; empty when `SSO_KEY` is missing or too short. */
export async function ssoKeys(secrets: SsoKeySecrets): Promise<SsoKey[]> {
  if (!secrets.current || secrets.current.length < SSO_KEY_MIN_LENGTH) return [];
  const usable = [secrets.current, secrets.previous].filter(
    (value): value is string => typeof value === "string" && value.length >= SSO_KEY_MIN_LENGTH,
  );
  return Promise.all(
    usable.map((secret) => {
      let key = cache.get(secret);
      if (!key) {
        key = derive(secret);
        cache.set(secret, key);
      }
      return key;
    }),
  );
}

const bound = (workspaceId: string) => encoder.encode(`portifact-sso:${workspaceId}:client_secret`);

/** Seals a client secret for one workspace with the current key. */
export async function sealSsoSecret(
  key: SsoKey,
  workspaceId: string,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: bound(workspaceId) },
    key.key,
    encoder.encode(plaintext),
  );
  const out = new Uint8Array(iv.length + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), iv.length);
  return toBase64(out);
}

/**
 * Opens a sealed secret, or null when no key held sealed it (a retired key) or it was altered:
 * the provider then cannot sign anyone in until an admin enters the secret again.
 */
export async function openSsoSecret(
  keys: readonly SsoKey[],
  keyId: string,
  workspaceId: string,
  box: string,
): Promise<string | null> {
  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key) return null;
  try {
    const bytes = fromBase64(box);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: bound(workspaceId) },
      key.key,
      bytes.slice(12),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
