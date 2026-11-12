// The keyed hash rate limits use for an email address (the sign-in limits, the report outcome
// counter): an HMAC with a Worker secret, so a key in `rate_limits` or a report row cannot be
// tested against a guessed address by someone who only reads the database.
export async function keyedHash(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
