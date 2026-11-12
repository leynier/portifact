// Hashes of decision 0027's plans: SHA-256 over UTF-8, and a canonical JSON with sorted keys so
// a plan read back from storage (whose key order a schema may change) hashes as it did when built.

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** JSON with object keys sorted at every level; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(inner).sort()) {
      sorted[key] = (inner as Record<string, unknown>)[key];
    }
    return sorted;
  });
}

export const utf8Length = (text: string) => new TextEncoder().encode(text).length;
