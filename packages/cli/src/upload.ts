// Sends the objects a publish needs straight to storage through the presigned URLs the API
// returned (plan section 9, "Carga y commit"). Each upload sends exactly the headers it was
// given, because they are part of the signature. URLs that expired, or are about to, are
// replaced through GET /publishes/:id, so a long upload resumes instead of starting over.
import { PreparedPublish, type UploadTarget } from "@portifact/contracts";
import { callApi, RETRY_ATTEMPTS, withRetries } from "./api.ts";
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";
import type { Session } from "./session.ts";

/** Uploads in flight at once. */
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
  onUploaded: (target: UploadTarget) => void;
}

export async function uploadAll(job: UploadJob): Promise<void> {
  const book = new UrlBook(job.session, job.uploadId, job.targets);
  let next = 0;
  let failure: { error: unknown } | undefined;

  // The first failure stops new uploads; the ones in flight finish before it is reported.
  const worker = async () => {
    while (!failure && next < job.targets.length) {
      const target = job.targets[next] as UploadTarget;
      next += 1;
      try {
        await uploadOne(job, book, target.sha256);
        job.onUploaded(target);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, job.targets.length) }, worker),
  );
  if (failure) throw failure.error;
}

async function uploadOne(job: UploadJob, book: UrlBook, sha256: string): Promise<void> {
  const { runtime } = job.session;
  const local = job.sources.get(sha256);
  if (!local) throw new CliError("server_error", messages.errors.server(job.session.server.origin));
  let renewed = false;
  let failures = 0;
  for (;;) {
    const target = book.get(sha256);
    if (!target) return;
    if (!renewed && Date.parse(target.expiresAt) - runtime.now() <= URL_EXPIRY_MARGIN_MS) {
      renewed = true;
      await book.renew(target);
      continue;
    }

    let response: Response | undefined;
    try {
      response = await runtime.fetch(target.url, {
        method: target.method,
        headers: target.headers,
        body: runtime.fileBody(local.source),
        duplex: "half",
        redirect: "manual",
      } as RequestInit);
      await response.body?.cancel();
    } catch {
      response = undefined;
    }
    if (response?.ok) return;

    // Storage answers 403 to an expired signature: get a fresh URL once and try again.
    if (response?.status === 403 && !renewed) {
      renewed = true;
      await book.renew(target);
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

/** The current URL of each pending object, renewed for every worker at once. */
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

  /** Undefined once the server no longer needs the object. */
  get(sha256: string): UploadTarget | undefined {
    return this.current.get(sha256);
  }

  /** Replaces the URLs, unless another worker already replaced the one the caller used. */
  async renew(used: UploadTarget): Promise<void> {
    if (this.renewing) return this.renewing;
    if (this.current.get(used.sha256) !== used) return;
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
