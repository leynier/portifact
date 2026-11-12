// The opaque visitor ID of decision 0026, "Identity". An HMAC of the artifact and the person
// under a key derived from a Worker secret: the same person gets the same ID in one artifact and
// unrelated IDs in two artifacts, and nobody without the secret can go from an ID back to an
// account or link two IDs. The account ID never reaches the page or the object.

const PURPOSE = new TextEncoder().encode("portifact artifact-data visitor v1");

async function visitorKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: PURPOSE },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * `v_` and 22 base64url characters (128 bits of the HMAC). `subject` is `a:<account ID>` for a
 * signed-in person or `c:<cookie value>` for an anonymous visitor cookie, so the two kinds can
 * never produce the same input.
 */
export async function visitorId(
  secret: string,
  artifactId: string,
  subject: { account: string } | { cookie: string },
): Promise<string> {
  if (secret.length < 32) throw new Error("the visitor secret needs at least 32 characters");
  const who = "account" in subject ? `a:${subject.account}` : `c:${subject.cookie}`;
  const input = new TextEncoder().encode(`${artifactId}\u0000${who}`);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await visitorKey(secret), input));
  return `v_${base64url(mac.slice(0, 16))}`;
}
