// Sends a publish's new objects straight to storage through the presigned URLs the API returned,
// then commits (plan section 9, "Carga y commit"). Each upload carries exactly the signed headers,
// which bind its size and SHA-256, so storage refuses other bytes. URLs that expired, or are
// about to, are replaced through GET /publishes/:id, and after a failure the same upload can be
// resumed: the API returns only the objects still missing.
import type { CommittedPublish, PreparedPublish, UploadTarget } from "@portifact/contracts";
import type { DashboardApi } from "../api.ts";

/** Talks to storage. The browser version uses XMLHttpRequest for upload progress. */
export interface StorageTransport {
  /**
   * Sends `body` to a presigned URL with the target's headers. Resolves with the HTTP status,
   * or 0 when storage could not be reached; rejects only when `signal` aborts.
   */
  put(
    target: UploadTarget,
    body: Blob,
    onProgress: (sentBytes: number) => void,
    signal: AbortSignal,
  ): Promise<number>;
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

/** Uploads in flight at once. */
export const UPLOAD_CONCURRENCY = 3;
/** URLs this close to expiry are replaced before use. */
export const URL_EXPIRY_MARGIN_MS = 30_000;
/** Attempts per object on network errors, 5xx and 429. */
export const UPLOAD_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;

export interface UploadProgress {
  sentBytes: number;
  totalBytes: number;
  doneObjects: number;
  totalObjects: number;
}

export interface UploadJob {
  api: Pick<DashboardApi, "uploadProgress">;
  transport: StorageTransport;
  prepared: PreparedPublish;
  /** The bytes of each object by SHA-256, and the path shown in messages. */
  objects: ReadonlyMap<string, { blob: Blob; path: string }>;
  onProgress(progress: UploadProgress): void;
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Uploads every pending object of `prepared`. The first failure stops new uploads. */
export async function uploadObjects(job: UploadJob): Promise<void> {
  const now = job.now ?? Date.now;
  const sleep = job.sleep ?? wait;
  const targets = job.prepared.uploads;
  for (const target of targets) {
    if (!job.objects.has(target.sha256)) throw new UploadFailure("missing");
  }
  const current = new Map(targets.map((target) => [target.sha256, target]));
  let renewing: Promise<void> | undefined;
  const renew = (used: UploadTarget): Promise<void> => {
    if (renewing) return renewing;
    if (current.get(used.sha256) !== used) return Promise.resolve();
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

  const totalBytes = targets.reduce((sum, target) => sum + target.size, 0);
  const inFlight = new Map<string, number>();
  let doneBytes = 0;
  let doneObjects = 0;
  const report = () => {
    let sentBytes = doneBytes;
    for (const sent of inFlight.values()) sentBytes += sent;
    job.onProgress({ sentBytes, totalBytes, doneObjects, totalObjects: targets.length });
  };

  const uploadOne = async (sha256: string): Promise<void> => {
    const object = job.objects.get(sha256) as { blob: Blob; path: string };
    let renewed = false;
    let failures = 0;
    for (;;) {
      if (job.signal.aborted) throw new UploadCancelled();
      const target = current.get(sha256);
      if (!target) return;
      if (!renewed && Date.parse(target.expiresAt) - now() <= URL_EXPIRY_MARGIN_MS) {
        renewed = true;
        await renew(target);
        continue;
      }
      inFlight.set(sha256, 0);
      const status = await job.transport.put(
        target,
        object.blob,
        (sent) => {
          inFlight.set(sha256, Math.min(sent, target.size));
          report();
        },
        job.signal,
      );
      inFlight.delete(sha256);
      if (status >= 200 && status < 300) return;
      // Storage answers 403 to an expired signature: get a fresh URL once and try again.
      if (status === 403 && !renewed) {
        renewed = true;
        await renew(target);
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
    while (!failure && next < targets.length) {
      const target = targets[next] as UploadTarget;
      next += 1;
      try {
        await uploadOne(target.sha256);
        doneBytes += target.size;
        doneObjects += 1;
        report();
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, targets.length) }, worker));
  if (job.signal.aborted) throw new UploadCancelled();
  if (failure) throw failure.error;
}

export type PublishPhase = "preparing" | "uploading" | "committing";

export interface PublishRun {
  api: Pick<DashboardApi, "preparePublish" | "uploadProgress" | "commitPublish" | "abortPublish">;
  transport: StorageTransport;
  request: Parameters<DashboardApi["preparePublish"]>[0];
  idempotencyKey: string;
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
    : await run.api.preparePublish(run.request, run.idempotencyKey);
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
