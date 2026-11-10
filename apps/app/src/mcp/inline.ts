// Inline publishing for MCP (plan sections 6 and 9). A remote server cannot read the client's
// files, so a small document arrives in the tool call. It still goes through the same manifest,
// reservation and commit as any upload: the Worker only stands in for the client's PUT.
import { type ArtifactType, type ErrorCode, LIMITS } from "@portifact/contracts";
import type { RegionalDb } from "@portifact/db";
import {
  abortPublish,
  type CommittedPublish,
  commitPublish,
  preparePublish,
} from "@portifact/services";

export type Outcome<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string };

/** The single file an inline document becomes, by artifact type. */
export const INLINE_FILES: Record<ArtifactType, { path: string; contentType: string }> = {
  site: { path: "index.html", contentType: "text/html; charset=utf-8" },
  markdown: { path: "index.md", contentType: "text/markdown; charset=utf-8" },
  text: { path: "index.txt", contentType: "text/plain; charset=utf-8" },
};

export interface InlinePublish {
  /** The signed-in user; the services resolve their role on the owner. */
  userId: string;
  /** The owner a new artifact is created for; the user's personal space when absent. */
  targetOwnerId?: string | undefined;
  type: ArtifactType;
  name: string;
  content: string;
  artifactId?: string | undefined;
  baseVersionId: string | null;
  now: number;
}

export async function publishInline(
  db: RegionalDb,
  bucket: R2Bucket,
  input: InlinePublish,
): Promise<Outcome<CommittedPublish>> {
  // A JSON string can hold lone surrogates, which have no UTF-8 encoding.
  if (!input.content.isWellFormed()) {
    return { ok: false, code: "invalid_input", message: "The content is not valid UTF-8 text." };
  }
  const bytes = new TextEncoder().encode(input.content);
  if (bytes.byteLength > LIMITS.inlineMcpBytes) {
    return {
      ok: false,
      code: "invalid_input",
      message: `Inline content is limited to ${LIMITS.inlineMcpBytes} bytes; this is ${bytes.byteLength}. Publish it with prepare_upload and commit_upload, or the portifact CLI, instead.`,
    };
  }
  const file = INLINE_FILES[input.type];
  const sha256 = await sha256Hex(bytes);
  const prepared = await preparePublish(db, {
    userId: input.userId,
    targetOwnerId: input.targetOwnerId,
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    type: input.type,
    name: input.name,
    entrypoint: file.path,
    baseVersionId: input.baseVersionId,
    files: [{ ...file, kind: "published", sha256, size: bytes.byteLength }],
    now: input.now,
  });
  if (!prepared.ok) return prepared;

  const session = { userId: input.userId, sessionId: prepared.value.sessionId, now: input.now };
  try {
    // Nothing to send when the account already stores these exact bytes.
    for (const upload of prepared.value.uploads) {
      await bucket.put(upload.r2Key, bytes, { sha256 });
    }
    const committed = await commitPublish(db, bucket, session);
    // A conflict already closed the upload; any other failure leaves it open.
    if (!committed.ok) await abortPublish(db, session);
    return committed;
  } catch (error) {
    // Release the reservation now instead of holding an upload slot until it expires.
    await abortPublish(db, session);
    throw error;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
