// Sealing of issue integration credentials (decision 0018): AES-256-GCM under a key derived with
// HKDF from the secret `INTEGRATIONS_KEY`, held by the app Worker (seals what an admin pastes) and
// the jobs Worker (opens it to create issues). Its own key rather than `WEBHOOK_KEY`: a GitHub
// token, Linear key or Jira token acts as a person at another service, so it rotates, leaks and switches on
// independently of webhook URLs. Each sealed value names the key that sealed it and is bound to
// its connection, so a value copied to another row does not open.

/** `INTEGRATIONS_KEY` and, during a rotation, `INTEGRATIONS_KEY_PREVIOUS`. */
export interface IntegrationKeySecrets {
  current: string | undefined;
  previous?: string | undefined;
}

export interface IntegrationKey {
  id: string;
  key: CryptoKey;
}

/** The shortest `INTEGRATIONS_KEY` accepted. */
export const INTEGRATIONS_KEY_MIN_LENGTH = 32;

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

async function derive(secret: string): Promise<IntegrationKey> {
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
    hkdf("portifact integrations seal v1"),
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const idKey = await crypto.subtle.deriveKey(
    hkdf("portifact integrations key id v1"),
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", idKey, encoder.encode("key-id")));
  const id = [...mac.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { id, key };
}

const cache = new Map<string, Promise<IntegrationKey>>();

/** The keys this Worker holds, current first; empty when `INTEGRATIONS_KEY` is missing or too short. */
export async function integrationKeys(secrets: IntegrationKeySecrets): Promise<IntegrationKey[]> {
  if (!secrets.current || secrets.current.length < INTEGRATIONS_KEY_MIN_LENGTH) return [];
  const usable = [secrets.current, secrets.previous].filter(
    (value): value is string =>
      typeof value === "string" && value.length >= INTEGRATIONS_KEY_MIN_LENGTH,
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

const bound = (connectionId: string) =>
  encoder.encode(`portifact-integration:${connectionId}:credential`);

/** Seals a credential for one connection with the current key. */
export async function sealCredential(
  key: IntegrationKey,
  connectionId: string,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: bound(connectionId) },
    key.key,
    encoder.encode(plaintext),
  );
  const out = new Uint8Array(iv.length + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), iv.length);
  return toBase64(out);
}

/**
 * Opens a sealed credential, or null when no key held sealed it (a retired key) or it was
 * altered: the connection then needs an admin to paste the credential again.
 */
export async function openCredential(
  keys: readonly IntegrationKey[],
  keyId: string,
  connectionId: string,
  box: string,
): Promise<string | null> {
  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key) return null;
  try {
    const bytes = fromBase64(box);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: bound(connectionId) },
      key.key,
      bytes.slice(12),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
