// Content addressing of stored objects: one R2 key per account and SHA-256.

export function objectKey(ownerId: string, sha256: string): string {
  return `objects/${ownerId}/${sha256}`;
}

export function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}
