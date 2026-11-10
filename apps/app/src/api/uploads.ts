// The upload half of publishing (plan section 9): open an upload for a manifest and answer with
// presigned targets for the objects the account does not store yet. `POST /api/v1/publishes`,
// `GET /api/v1/publishes/:uploadId` and the MCP tools prepare_upload and get_upload_status all
// build their bodies here, so every client gets the same instructions.
import { PreparedPublish, type PublishRequest } from "@portifact/contracts";
import type { RegionalDb } from "@portifact/db";
import { type MultipartConfig, partRange } from "@portifact/domain";
import {
  type PendingUpload,
  type PreparedUpload,
  preparePublish,
  type StoredResponse,
} from "@portifact/services";
import { failure, iso } from "./http.ts";
import type { Presigner } from "./presign.ts";

export interface UploadDeps {
  bucket: R2Bucket;
  presigner: Presigner;
  /** Threshold and part size of multipart uploads; undefined for the defaults. */
  multipart: MultipartConfig | undefined;
}

/** Opens an upload; a stored response, so an idempotent retry replays it exactly. */
export async function prepareUpload(
  db: RegionalDb,
  deps: UploadDeps,
  userId: string,
  body: PublishRequest,
  now: number,
  /** The owner a new artifact is created for, from `ownerScope`; the personal space when absent. */
  targetOwnerId?: string,
): Promise<StoredResponse> {
  const multipart = body.multipart
    ? { bucket: deps.bucket, ...(deps.multipart ? { config: deps.multipart } : {}) }
    : undefined;
  const result = await preparePublish(
    db,
    {
      userId,
      targetOwnerId,
      ...(body.artifactId ? { artifactId: body.artifactId } : {}),
      type: body.type,
      name: body.name,
      entrypoint: body.entrypoint,
      baseVersionId: body.baseVersionId,
      files: body.files,
      sourceOrigin: body.sourceOrigin,
      now,
    },
    multipart,
  );
  if (!result.ok) return failure(result.code, result.message);
  return { status: 201, body: await preparedPublish(deps.presigner, result.value, now) };
}

export async function preparedPublish(
  presigner: Presigner,
  upload: PreparedUpload,
  now: number,
): Promise<PreparedPublish> {
  return PreparedPublish.parse({
    artifactId: upload.artifactId,
    versionId: upload.versionId,
    versionNumber: upload.versionNumber,
    uploadId: upload.sessionId,
    expiresAt: iso(upload.expiresAt),
    uploads: await Promise.all(upload.uploads.map((pending) => target(presigner, pending, now))),
  });
}

async function target(presigner: Presigner, upload: PendingUpload, now: number) {
  const { multipart } = upload;
  if (multipart) {
    const done = new Set(multipart.doneParts);
    const missing: number[] = [];
    for (let part = 1; part <= multipart.partCount; part += 1) {
      if (!done.has(part)) missing.push(part);
    }
    return {
      sha256: upload.sha256,
      size: upload.size,
      method: "MULTIPART" as const,
      partSize: multipart.partSize,
      partCount: multipart.partCount,
      doneParts: multipart.doneParts,
      parts: await Promise.all(
        missing.map(async (partNumber) => {
          const range = partRange(upload.size, multipart, partNumber);
          const signed = await presigner.presignPart(
            multipart.key,
            multipart.uploadId,
            partNumber,
            range.size,
            now,
          );
          return {
            partNumber,
            ...range,
            method: "PUT" as const,
            url: signed.url,
            headers: signed.headers,
            expiresAt: iso(signed.expiresAt),
          };
        }),
      ),
    };
  }
  const signed = await presigner.presignPut(upload.r2Key, upload.size, upload.sha256, now);
  return {
    sha256: upload.sha256,
    size: upload.size,
    method: "PUT" as const,
    url: signed.url,
    headers: signed.headers,
    expiresAt: iso(signed.expiresAt),
  };
}
