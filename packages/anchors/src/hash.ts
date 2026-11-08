// The content hash stored with a target (`contentHash` in the contracts): lowercase hex SHA-256
// of the UTF-8 normalized text, so every interface hashes the same bytes.
import { normalizeText } from "./normalize.ts";

export async function contentHash(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeText(raw));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
