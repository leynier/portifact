// Sealing and signing for webhooks (decision 0009, "Storage and secrets" and "Signing"). The URL
// and the signing secret are sealed with AES-256-GCM under a key derived with HKDF from the Worker
// secret `WEBHOOK_KEY`; each sealed value names the key that sealed it and is bound to its webhook
// and its column, so a value copied elsewhere does not open. Deliveries are signed the Standard
// Webhooks way.
import { signedContent } from "@portifact/domain";

/** `WEBHOOK_KEY` and, during a rotation, `WEBHOOK_KEY_PREVIOUS`. */
export interface WebhookKeySecrets {
  current: string | undefined;
  previous?: string | undefined;
}

export type SealPurpose = "url" | "secret";

interface DerivedKey {
  id: string;
  key: CryptoKey;
}

/** The shortest `WEBHOOK_KEY` accepted. */
export const WEBHOOK_KEY_MIN_LENGTH = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function derive(secret: string): Promise<DerivedKey> {
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
    hkdf("portifact webhook seal v1"),
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const idKey = await crypto.subtle.deriveKey(
    hkdf("portifact webhook key id v1"),
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const id = hex(await crypto.subtle.sign("HMAC", idKey, encoder.encode("key-id"))).slice(0, 16);
  return { id, key };
}

const cache = new Map<string, Promise<DerivedKey>>();

function derived(secret: string): Promise<DerivedKey> {
  let key = cache.get(secret);
  if (!key) {
    key = derive(secret);
    cache.set(secret, key);
  }
  return key;
}

/** The keys a Worker holds, current first; empty when `WEBHOOK_KEY` is missing or too short. */
export async function webhookKeys(secrets: WebhookKeySecrets): Promise<DerivedKey[]> {
  const usable = [secrets.current, secrets.previous].filter(
    (value): value is string => typeof value === "string" && value.length >= WEBHOOK_KEY_MIN_LENGTH,
  );
  if (!secrets.current || secrets.current.length < WEBHOOK_KEY_MIN_LENGTH) return [];
  return Promise.all(usable.map(derived));
}

function additionalData(webhookId: string, purpose: SealPurpose) {
  return encoder.encode(`portifact-webhook:${webhookId}:${purpose}`);
}

/** Seals a value for one webhook and column with the current key. */
export async function seal(
  key: DerivedKey,
  webhookId: string,
  purpose: SealPurpose,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(webhookId, purpose) },
    key.key,
    encoder.encode(plaintext),
  );
  const out = new Uint8Array(iv.length + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), iv.length);
  return toBase64(out);
}

/** Opens a sealed value with the key it names; throws when no key held matches or it was altered. */
export async function open(
  keys: readonly DerivedKey[],
  keyId: string,
  webhookId: string,
  purpose: SealPurpose,
  box: string,
): Promise<string> {
  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key) throw new Error("No webhook key matches the sealed value");
  const bytes = fromBase64(box);
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes.slice(0, 12),
      additionalData: additionalData(webhookId, purpose),
    },
    key.key,
    bytes.slice(12),
  );
  return decoder.decode(plain);
}

/** A new signing secret in the Standard Webhooks form: `whsec_` and 32 random bytes in base64. */
export function newWebhookSecret(): string {
  return `whsec_${toBase64(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/**
 * The `webhook-signature` header: `v1,` and the base64 HMAC-SHA-256 of `<id>.<timestamp>.<body>`
 * keyed with the secret's bytes (the base64 after `whsec_`).
 */
export async function signWebhook(
  secret: string,
  id: string,
  timestampSeconds: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedContent(id, timestampSeconds, body)),
  );
  return `v1,${toBase64(new Uint8Array(mac))}`;
}
