// Sends the objects a publish needs straight to storage through the presigned URLs the API
// returned (plan section 9, "Carga y commit"). Each upload sends exactly the headers it was
// given, because they are part of the signature. URLs that expired, or are about to, are
// replaced through GET /publishes/:id, so a long upload resumes instead of starting over.
//
// A large object comes as a multipart target: each part is a byte range of the file, streamed
// from disk on its own (never the whole file in memory), put to its own URL and then reported
// with the ETag storage answered, so the server knows which parts are done. Parts of all objects
// share one pool of `UPLOAD_CONCURRENCY` uploads, which bounds memory and connections.
import {
  type MultipartUploadTarget,
  PreparedPublish,
  type SingleUploadTarget,
  type UploadPartTarget,
  type UploadTarget,
} from "@portifact/contracts";
import { callApi, RETRY_ATTEMPTS, withRetries } from "./api.ts";
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";
import type { Session } from "./session.ts";

/** Uploads (objects or parts) in flight at once. */
export const UPLOAD_CONCURRENCY = 4;
/** URLs this close to expiry are replaced before use. */
export const URL_EXPIRY_MARGIN_MS = 30_000;
const RETRY_BASE_MS = 1_000;

export interface UploadJob {
  session: Session;
  uploadId: string;
  targets: readonly UploadTarget[];
  /** Local file for each SHA-256, and the artifact path shown in messages. */
  sources: ReadonlyMap<string, { source: string; path: string }>;
  /** An object is complete: its one upload, or all of its parts. */
  onUploaded: (target: UploadTarget) => void;
  /** One part of a multipart object reached storage and was reported. */
  onPart?: (target: MultipartUploadTarget, partNumber: number, bytes: number) => void;
}

/** One request to storage: a whole object, or one part of a multipart object. */
interface Unit {
  sha256: string;
  partNumber?: number;
}

export async function uploadAll(job: UploadJob): Promise<void> {
  const book = new UrlBook(job.session, job.uploadId, job.targets);
  const units: Unit[] = job.targets.flatMap((target) =>
    target.method === "MULTIPART"
      ? target.parts.map((part) => ({ sha256: target.sha256, partNumber: part.partNumber }))
      : [{ sha256: target.sha256 }],
  );
  // Parts each object still waits for; an object is done when none are left.
  const remaining = new Map(
    job.targets.map((target) => [
      target.sha256,
      target.method === "MULTIPART" ? target.parts.length : 1,
    ]),
  );
  for (const target of job.targets) {
    if (remaining.get(target.sha256) === 0) job.onUploaded(target);
  }
  let next = 0;
  let failure: { error: unknown } | undefined;

  // The first failure stops new uploads; the ones in flight finish before it is reported.
  const worker = async () => {
    while (!failure && next < units.length) {
      const unit = units[next] as Unit;
      next += 1;
      try {
        await uploadUnit(job, book, unit);
        const left = (remaining.get(unit.sha256) ?? 1) - 1;
        remaining.set(unit.sha256, left);
        const target = job.targets.find((t) => t.sha256 === unit.sha256) as UploadTarget;
        if (left === 0) job.onUploaded(target);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, units.length) }, worker));
  if (failure) throw failure.error;
}

async function uploadUnit(job: UploadJob, book: UrlBook, unit: Unit): Promise<void> {
  const { runtime } = job.session;
  const local = job.sources.get(unit.sha256);
  if (!local) throw new CliError("server_error", messages.errors.server(job.session.server.origin));
  let renewed = false;
  let failures = 0;
  for (;;) {
    const request = book.get(unit);
    // The server no longer needs it: stored meanwhile, or the part was already reported.
    if (!request) return;
    if (!renewed && Date.parse(request.expiresAt) - runtime.now() <= URL_EXPIRY_MARGIN_MS) {
      renewed = true;
      await book.renew(request);
      continue;
    }

    let response: Response | undefined;
    try {
      response = await runtime.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body:
          "partNumber" in request
            ? runtime.fileBody(local.source, {
                start: request.offset,
                end: request.offset + request.size,
              })
            : runtime.fileBody(local.source),
        duplex: "half",
        redirect: "manual",
      } as RequestInit);
      await response.body?.cancel();
    } catch {
      response = undefined;
    }
    if (response?.ok) {
      if ("partNumber" in request) await reportPart(job, book, unit, request, response, local.path);
      return;
    }

    // Storage answers 403 to an expired signature: get a fresh URL once and try again.
    if (response?.status === 403 && !renewed) {
      renewed = true;
      await book.renew(request);
      continue;
    }
    const transient = !response || response.status >= 500 || response.status === 429;
    failures += 1;
    if (transient && failures < RETRY_ATTEMPTS) {
      await runtime.sleep(RETRY_BASE_MS * 2 ** (failures - 1));
      continue;
    }
    throw new CliError("upload_failed", messages.errors.uploadFailed(local.path));
  }
}

/** Tells the API a part is stored, with its ETag, so the commit can assemble the object. */
async function reportPart(
  job: UploadJob,
  book: UrlBook,
  unit: Unit,
  part: UploadPartTarget,
  response: Response,
  path: string,
): Promise<void> {
  const etag = response.headers.get("etag");
  if (!etag) throw new CliError("upload_failed", messages.errors.uploadFailed(path));
  await withRetries(job.session, () =>
    callApi(job.session, {
      method: "POST",
      path: `/publishes/${encodeURIComponent(job.uploadId)}/parts`,
      body: { sha256: unit.sha256, partNumber: part.partNumber, etag },
    }),
  );
  const target = book.target(unit.sha256);
  if (target?.method === "MULTIPART") job.onPart?.(target, part.partNumber, part.size);
}

/** The current URL of each pending object and part, renewed for every worker at once. */
class UrlBook {
  private readonly current: Map<string, UploadTarget>;
  private renewing: Promise<void> | undefined;

  constructor(
    private readonly session: Session,
    private readonly uploadId: string,
    targets: readonly UploadTarget[],
  ) {
    this.current = new Map(targets.map((target) => [target.sha256, target]));
  }

  target(sha256: string): UploadTarget | undefined {
    return this.current.get(sha256);
  }

  /** Undefined once the server no longer needs the object or the part. */
  get(unit: Unit): SingleUploadTarget | UploadPartTarget | undefined {
    const target = this.current.get(unit.sha256);
    if (!target) return undefined;
    if (unit.partNumber === undefined) return target.method === "PUT" ? target : undefined;
    if (target.method !== "MULTIPART") return undefined;
    return target.parts.find((part) => part.partNumber === unit.partNumber);
  }

  /** Replaces the URLs, unless another worker already replaced the one the caller used. */
  async renew(used: SingleUploadTarget | UploadPartTarget): Promise<void> {
    if (this.renewing) return this.renewing;
    if (![...this.current.values()].some((target) => target === used || owns(target, used))) {
      return;
    }
    this.renewing = this.fetchFresh().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  private async fetchFresh(): Promise<void> {
    const fresh = await withRetries(this.session, () =>
      callApi(this.session, {
        method: "GET",
        path: `/publishes/${encodeURIComponent(this.uploadId)}`,
        schema: PreparedPublish,
      }),
    );
    const pending = new Map(fresh.uploads.map((target) => [target.sha256, target]));
    for (const sha256 of [...this.current.keys()]) {
      const target = pending.get(sha256);
      if (target) this.current.set(sha256, target);
      else this.current.delete(sha256);
    }
  }
}

function owns(target: UploadTarget, part: SingleUploadTarget | UploadPartTarget): boolean {
  return target.method === "MULTIPART" && target.parts.some((candidate) => candidate === part);
}
