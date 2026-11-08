// Presigned R2 uploads (plan section 9, step 4). The client sends each new object straight to
// R2's S3 endpoint, so large files never pass through the Worker. The URL signs the exact size
// and SHA-256, so R2 rejects any other bytes, and the object key is immutable per content.
import { AwsClient } from "aws4fetch";

/** Upload URLs are short-lived; the client can ask for fresh ones while the upload is open. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

export interface PresignedUpload {
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}

export interface Presigner {
  presignPut(key: string, size: number, sha256Hex: string, now: number): Promise<PresignedUpload>;
}

export interface R2Credentials {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Base64 of the raw digest, the form `x-amz-checksum-sha256` takes. */
export function checksumHeader(sha256Hex: string): string {
  let binary = "";
  for (let i = 0; i < sha256Hex.length; i += 2) {
    binary += String.fromCharCode(Number.parseInt(sha256Hex.slice(i, i + 2), 16));
  }
  return btoa(binary);
}

export function r2Presigner(credentials: R2Credentials): Presigner {
  const client = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const endpoint = `https://${credentials.accountId}.r2.cloudflarestorage.com/${credentials.bucket}`;
  return {
    async presignPut(key, size, sha256Hex, now) {
      const url = new URL(`${endpoint}/${key.split("/").map(encodeURIComponent).join("/")}`);
      url.searchParams.set("X-Amz-Expires", String(UPLOAD_URL_TTL_SECONDS));
      const headers = {
        "content-length": String(size),
        "x-amz-checksum-sha256": checksumHeader(sha256Hex),
      };
      const signed = await client.sign(url.toString(), {
        method: "PUT",
        headers,
        aws: {
          signQuery: true,
          // Size and checksum are signed, so an upload with other bytes is refused by R2.
          allHeaders: true,
          datetime: new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, ""),
        },
      });
      return { url: signed.url, headers, expiresAt: now + UPLOAD_URL_TTL_SECONDS * 1000 };
    },
  };
}
