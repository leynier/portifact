// Sends a publish's new objects straight to storage through the presigned URLs the API returned,
// then commits (plan section 9, "Carga y commit"). Each upload carries exactly the signed headers,
// which bind its size and SHA-256, so storage refuses other bytes. URLs that expired, or are
// about to, are replaced through GET /publishes/:id, and after a failure the same upload can be
// resumed: the API returns only the objects, and parts of large objects, still missing.
import type {
  CommittedPublish,
  MultipartUploadTarget,
  PreparedPublish,
  SingleUploadTarget,
  UploadPartTarget,
  UploadTarget,
} from "@portifact/contracts";
import type { DashboardApi } from "../api.ts";

/** One presigned request to storage: a whole object, or one part of a multipart object. */
export type StorageRequest = SingleUploadTarget | UploadPartTarget;

/** What storage answered: the HTTP status (0 when unreachable) and the ETag of a stored part. */
export interface StorageAnswer {
  status: number;
  etag?: string | null;
}

/** Talks to storage. The browser version uses XMLHttpRequest for upload progress. */
export interface StorageTransport {
  /**
   * Sends `body` to a presigned URL with the request's headers. Resolves with what storage
   * answered; rejects only when `signal` aborts.
   */
  put(
    request: StorageRequest,
    body: Blob,
    onProgress: (sentBytes: number) => void,
    signal: AbortSignal,
  ): Promise<StorageAnswer>;
  /** Reads a presigned download link; rejects when it cannot. */
  get(url: string, signal?: AbortSignal): Promise<Blob>;
}

export type UploadFailureReason =
  /** Storage refused the bytes for their checksum or size. */
  | "integrity"
  /** Storage refused the upload for another reason, or kept failing. */
  | "storage"
  /** Storage could not be reached. */
  | "network"
  /** The API asked for an object this page does not have. */
  | "missing";

export class UploadFailure extends Error {
  constructor(
    readonly reason: UploadFailureReason,
    readonly path?: string,
  ) {
    super(path ? `${reason}: ${path}` : reason);
    this.name = "UploadFailure";
  }
}

export class UploadCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "UploadCancelled";
  }
}

/** Uploads (objects or parts) in flight at once. */
export const UPLOAD_CONCURRENCY = 3;
/** URLs this close to expiry are replaced before use. */
export const URL_EXPIRY_MARGIN_MS = 30_000;
/** Attempts per object or part on network errors, 5xx and 429. */
export const UPLOAD_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;

export interface UploadProgress {
  sentBytes: number;
  totalBytes: number;
  doneObjects: number;
  totalObjects: number;
}

export interface UploadJob {
  api: Pick<DashboardApi, "uploadProgress" | "reportPart">;
  transport: StorageTransport;
  prepared: PreparedPublish;
  /** The bytes of each object by SHA-256, and the path shown in messages. */
  objects: ReadonlyMap<string, { blob: Blob; path: string }>;
  onProgress(progress: UploadProgress): void;
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** One request to storage: a whole object, or one part of a multipart object. */
interface Unit {
  sha256: string;
  partNumber?: number;
  size: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function unitKey(unit: Unit): string {
  return unit.partNumber === undefined ? unit.sha256 : `${unit.sha256}:${unit.partNumber}`;
}

/** Bytes a multipart object already has in storage, from the parts the API says are done. */
function doneBytesOf(target: MultipartUploadTarget): number {
  return target.doneParts.reduce(
    (sum, part) => sum + Math.min(target.partSize, target.size - (part - 1) * target.partSize),
    0,
  );
}

/**
 * Uploads every pending object of `prepared`. A multipart object goes part by part: each part
 * is a slice of the file (the browser reads it from disk as it sends), put to its own URL and
 * reported with its ETag, so a later attempt sends only the parts still missing. The first
 * failure stops new uploads.
 */
export async function uploadObjects(job: UploadJob): Promise<void> {
  const now = job.now ?? Date.now;
  const sleep = job.sleep ?? wait;
  const targets = job.prepared.uploads;
  for (const target of targets) {
    if (!job.objects.has(target.sha256)) throw new UploadFailure("missing");
  }
  const current = new Map<string, UploadTarget>(targets.map((target) => [target.sha256, target]));
  let renewing: Promise<void> | undefined;
  const requestFor = (unit: Unit): StorageRequest | undefined => {
    const target = current.get(unit.sha256);
    if (!target) return undefined;
    if (unit.partNumber === undefined) return target.method === "PUT" ? target : undefined;
    if (target.method !== "MULTIPART") return undefined;
    return target.parts.find((part) => part.partNumber === unit.partNumber);
  };
  const renew = (unit: Unit, used: StorageRequest): Promise<void> => {
    if (renewing) return renewing;
    if (requestFor(unit) !== used) return Promise.resolve();
    renewing = job.api
      .uploadProgress(job.prepared.uploadId)
      .then((fresh) => {
        const pending = new Map(fresh.uploads.map((target) => [target.sha256, target]));
        for (const sha256 of [...current.keys()]) {
          const target = pending.get(sha256);
          if (target) current.set(sha256, target);
          else current.delete(sha256);
        }
      })
      .finally(() => {
        renewing = undefined;
      });
    return renewing;
  };

  const units: Unit[] = targets.flatMap((target) =>
    target.method === "MULTIPART"
      ? target.parts.map((part) => ({
          sha256: target.sha256,
          partNumber: part.partNumber,
          size: part.size,
        }))
      : [{ sha256: target.sha256, size: target.size }],
  );
  const remaining = new Map(
    targets.map((target) => [
      target.sha256,
      target.method === "MULTIPART" ? target.parts.length : 1,
    ]),
  );
  const totalBytes = targets.reduce((sum, target) => sum + target.size, 0);
  const inFlight = new Map<string, number>();
  let doneBytes = targets.reduce(
    (sum, target) => sum + (target.method === "MULTIPART" ? doneBytesOf(target) : 0),
    0,
  );
  let doneObjects = [...remaining.values()].filter((left) => left === 0).length;
  const report = () => {
    let sentBytes = doneBytes;
    for (const sent of inFlight.values()) sentBytes += sent;
    job.onProgress({ sentBytes, totalBytes, doneObjects, totalObjects: targets.length });
  };

  const uploadOne = async (unit: Unit): Promise<void> => {
    const object = job.objects.get(unit.sha256) as { blob: Blob; path: string };
    const key = unitKey(unit);
    let renewed = false;
    let failures = 0;
    for (;;) {
      if (job.signal.aborted) throw new UploadCancelled();
      const request = requestFor(unit);
      if (!request) return;
      if (!renewed && Date.parse(request.expiresAt) - now() <= URL_EXPIRY_MARGIN_MS) {
        renewed = true;
        await renew(unit, request);
        continue;
      }
      const body =
        "partNumber" in request
          ? object.blob.slice(request.offset, request.offset + request.size)
          : object.blob;
      inFlight.set(key, 0);
      const answer = await job.transport.put(
        request,
        body,
        (sent) => {
          inFlight.set(key, Math.min(sent, request.size));
          report();
        },
        job.signal,
      );
      inFlight.delete(key);
      const { status } = answer;
      if (status >= 200 && status < 300) {
        if ("partNumber" in request) {
          // Without the ETag (the bucket's CORS rule must expose it) the part cannot be used.
          if (!answer.etag) throw new UploadFailure("storage", object.path);
          await job.api.reportPart(job.prepared.uploadId, {
            sha256: unit.sha256,
            partNumber: request.partNumber,
            etag: answer.etag,
          });
        }
        return;
      }
      // Storage answers 403 to an expired signature: get a fresh URL once and try again.
      if (status === 403 && !renewed) {
        renewed = true;
        await renew(unit, request);
        continue;
      }
      if (status === 400) throw new UploadFailure("integrity", object.path);
      const transient = status === 0 || status >= 500 || status === 429;
      failures += 1;
      if (transient && failures < UPLOAD_ATTEMPTS) {
        await sleep(RETRY_BASE_MS * 2 ** (failures - 1));
        continue;
      }
      throw new UploadFailure(status === 0 ? "network" : "storage", object.path);
    }
  };

  report();
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < units.length) {
      const unit = units[next] as Unit;
      next += 1;
      try {
        await uploadOne(unit);
        doneBytes += unit.size;
        const left = (remaining.get(unit.sha256) ?? 1) - 1;
        remaining.set(unit.sha256, left);
        if (left === 0) doneObjects += 1;
        report();
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, units.length) }, worker));
  if (job.signal.aborted) throw new UploadCancelled();
  if (failure) throw failure.error;
}

export type PublishPhase = "preparing" | "uploading" | "committing";

export interface PublishRun {
  api: Pick<
    DashboardApi,
    "preparePublish" | "uploadProgress" | "reportPart" | "commitPublish" | "abortPublish"
  >;
  transport: StorageTransport;
  request: Parameters<DashboardApi["preparePublish"]>[0];
  idempotencyKey: string;
  /** The workspace a new artifact goes to; the personal space without it. */
  workspace?: string | undefined;
  objects: UploadJob["objects"];
  /** An upload prepared by an earlier attempt, to resume instead of preparing again. */
  resume?: PreparedPublish | undefined;
  onPhase(phase: PublishPhase, prepared?: PreparedPublish): void;
  onProgress(progress: UploadProgress): void;
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Prepares (or resumes), uploads and commits a publish. Cancelling aborts the upload so its
 * reservation is released; a failure keeps it open, so the caller can resume it.
 */
export async function runPublish(run: PublishRun): Promise<CommittedPublish> {
  run.onPhase("preparing");
  const prepared = run.resume
    ? await run.api.uploadProgress(run.resume.uploadId)
    : // This uploader sends large objects in parts, so it asks for multipart targets.
      await run.api.preparePublish(
        { ...run.request, multipart: true },
        run.idempotencyKey,
        run.workspace,
      );
  run.onPhase("uploading", prepared);
  try {
    await uploadObjects({
      api: run.api,
      transport: run.transport,
      prepared,
      objects: run.objects,
      onProgress: run.onProgress,
      signal: run.signal,
      ...(run.now ? { now: run.now } : {}),
      ...(run.sleep ? { sleep: run.sleep } : {}),
    });
    if (run.signal.aborted) throw new UploadCancelled();
    run.onPhase("committing", prepared);
    return await run.api.commitPublish(prepared.uploadId);
  } catch (error) {
    if (error instanceof UploadCancelled) {
      await run.api.abortPublish(prepared.uploadId).catch(() => {});
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { prepared });
  }
}

/** The upload a failed run left open, if it got that far. */
export function preparedOf(error: unknown): PreparedPublish | undefined {
  return typeof error === "object" && error !== null && "prepared" in error
    ? (error.prepared as PreparedPublish)
    : undefined;
}
