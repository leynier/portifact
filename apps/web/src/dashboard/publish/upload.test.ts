import type {
  MultipartUploadTarget,
  PreparedPublish,
  SingleUploadTarget,
  UploadedPart,
  UploadTarget,
} from "@portifact/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiFailure } from "../api.ts";
import { canResume, publishFailureMessage } from "./failures.ts";
import {
  preparedOf,
  runPublish,
  type StorageTransport,
  UPLOAD_ATTEMPTS,
  UploadCancelled,
  UploadFailure,
  type UploadProgress,
  uploadObjects,
} from "./upload.ts";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const later = (ms: number) => new Date(NOW + ms).toISOString();

function target(sha: string, size: number, expiresIn = 600_000, sig = "1"): SingleUploadTarget {
  return {
    sha256: sha.padEnd(64, "0"),
    size,
    method: "PUT",
    url: `https://storage.test/${sha}?sig=${sig}`,
    headers: { "content-length": String(size), "x-amz-checksum-sha256": "x" },
    expiresAt: later(expiresIn),
  };
}

function prepared(uploads: UploadTarget[]): PreparedPublish {
  return {
    artifactId: "abcdefghij",
    versionId: "v1",
    versionNumber: 1,
    uploadId: "up1",
    expiresAt: later(86_400_000),
    uploads,
  };
}

function objectsFor(targets: UploadTarget[]) {
  return new Map(
    targets.map((t) => [
      t.sha256,
      { blob: new Blob(["x".repeat(t.size)]), path: `${t.sha256.slice(0, 1)}.html` },
    ]),
  );
}

/** Storage that answers each URL from a script; unscripted URLs succeed. */
function scriptedStorage(script: Record<string, number[]> = {}) {
  const calls: string[] = [];
  const transport: StorageTransport = {
    async put(t, body, onProgress, signal) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      calls.push(t.url);
      const status = script[t.url]?.shift() ?? 200;
      if (status === 200) onProgress(body.size);
      return { status, etag: `"etag-${t.url}"` };
    },
    get: () => Promise.reject(new Error("unused")),
  };
  return { transport, calls };
}

function job(
  targets: UploadTarget[],
  transport: StorageTransport,
  extra: Omit<Partial<Parameters<typeof uploadObjects>[0]>, "api"> = {},
) {
  const api = {
    uploadProgress: vi.fn(async (_id: string) => prepared(targets)),
    reportPart: vi.fn(async (_id: string, _part: UploadedPart) => {}),
  };
  const sleep = vi.fn(async (_ms: number) => {});
  return {
    transport,
    prepared: prepared(targets),
    objects: objectsFor(targets),
    onProgress: vi.fn(),
    signal: new AbortController().signal,
    now: () => NOW,
    ...extra,
    api,
    sleep,
  };
}

describe("uploadObjects", () => {
  it("sends every object and reports progress up to the total", async () => {
    const targets = [target("a", 3), target("b", 4), target("c", 5), target("d", 6)];
    const { transport, calls } = scriptedStorage();
    const progress: UploadProgress[] = [];
    await uploadObjects(job(targets, transport, { onProgress: (p) => progress.push(p) }));
    expect(calls.sort()).toEqual(targets.map((t) => t.url).sort());
    expect(progress[0]).toEqual({ sentBytes: 0, totalBytes: 18, doneObjects: 0, totalObjects: 4 });
    expect(progress.at(-1)).toEqual({
      sentBytes: 18,
      totalBytes: 18,
      doneObjects: 4,
      totalObjects: 4,
    });
  });

  it("refuses to start when the API asks for an object this page does not have", async () => {
    const targets = [target("a", 3)];
    const { transport, calls } = scriptedStorage();
    const error = await uploadObjects(job(targets, transport, { objects: new Map() })).catch(
      (e: unknown) => e,
    );
    expect(error).toEqual(new UploadFailure("missing"));
    expect(calls).toEqual([]);
  });

  it("replaces URLs that are about to expire before using them", async () => {
    const stale = target("a", 3, 10_000, "old");
    const fresh = target("a", 3, 600_000, "new");
    const { transport, calls } = scriptedStorage();
    const run = job([stale], transport);
    run.api.uploadProgress.mockResolvedValue(prepared([fresh]));
    await uploadObjects(run);
    expect(run.api.uploadProgress).toHaveBeenCalledWith("up1");
    expect(calls).toEqual([fresh.url]);
  });

  it("gets a fresh URL once after storage refuses an expired signature", async () => {
    const first = target("a", 3, 600_000, "first");
    const second = target("a", 3, 600_000, "second");
    const { transport, calls } = scriptedStorage({ [first.url]: [403], [second.url]: [403] });
    const run = job([first], transport);
    run.api.uploadProgress.mockResolvedValue(prepared([second]));
    const error = await uploadObjects(run).catch((e: unknown) => e);
    expect(calls).toEqual([first.url, second.url]);
    expect(error).toEqual(new UploadFailure("storage", "a.html"));
  });

  it("stops sending an object the API no longer needs", async () => {
    const stale = target("a", 3, 10_000);
    const { transport, calls } = scriptedStorage();
    const run = job([stale], transport);
    run.api.uploadProgress.mockResolvedValue(prepared([]));
    await uploadObjects(run);
    expect(calls).toEqual([]);
  });

  it("retries network errors, 5xx and 429 with backoff, then gives up", async () => {
    const flaky = target("a", 3);
    const { transport, calls } = scriptedStorage({ [flaky.url]: [0, 503, 200] });
    const run = job([flaky], transport);
    await uploadObjects(run);
    expect(calls).toHaveLength(3);
    expect(run.sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(run.sleep).toHaveBeenNthCalledWith(2, 2_000);

    const down = target("b", 3);
    const failing = scriptedStorage({ [down.url]: Array(UPLOAD_ATTEMPTS).fill(0) });
    const error = await uploadObjects(job([down], failing.transport)).catch((e: unknown) => e);
    expect(error).toEqual(new UploadFailure("network", "b.html"));
    expect(failing.calls).toHaveLength(UPLOAD_ATTEMPTS);

    const limited = target("c", 3);
    const busy = scriptedStorage({ [limited.url]: [429, 429, 429] });
    expect(await uploadObjects(job([limited], busy.transport)).catch((e: unknown) => e)).toEqual(
      new UploadFailure("storage", "c.html"),
    );
  });

  it("fails at once when storage refuses the bytes for their checksum", async () => {
    const bad = target("a", 3);
    const { transport, calls } = scriptedStorage({ [bad.url]: [400] });
    const error = await uploadObjects(job([bad, target("b", 1)], transport)).catch(
      (e: unknown) => e,
    );
    expect(error).toEqual(new UploadFailure("integrity", "a.html"));
    expect(calls).toContain(bad.url);
  });

  it("stops with a cancellation when its signal aborts", async () => {
    const controller = new AbortController();
    const t = target("a", 3);
    const transport: StorageTransport = {
      put: async () => {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      },
      get: () => Promise.reject(new Error("unused")),
    };
    const error = await uploadObjects(job([t], transport, { signal: controller.signal })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UploadCancelled);
  });
});

describe("runPublish", () => {
  const request = {
    type: "site" as const,
    name: "Plan",
    entrypoint: "index.html",
    baseVersionId: null,
    files: [],
  };

  function api(targets: UploadTarget[]) {
    return {
      preparePublish: vi.fn(async () => prepared(targets)),
      uploadProgress: vi.fn(async () => prepared(targets)),
      commitPublish: vi.fn(async () => ({
        artifactId: "abcdefghij",
        versionId: "v1",
        versionNumber: 1,
        url: "https://abcdefghij.portifact.dev/",
        expiresAt: later(1),
      })),
      abortPublish: vi.fn(async () => {}),
      reportPart: vi.fn(async () => {}),
    };
  }

  it("prepares with the idempotency key, uploads and commits, reporting each phase", async () => {
    const targets = [target("a", 3)];
    const calls = api(targets);
    const phases: string[] = [];
    const committed = await runPublish({
      api: calls,
      transport: scriptedStorage().transport,
      request,
      idempotencyKey: "key-12345",
      objects: objectsFor(targets),
      onPhase: (phase) => phases.push(phase),
      onProgress: () => {},
      signal: new AbortController().signal,
      now: () => NOW,
    });
    expect(committed.versionNumber).toBe(1);
    expect(calls.preparePublish).toHaveBeenCalledWith({ ...request, multipart: true }, "key-12345");
    expect(calls.commitPublish).toHaveBeenCalledWith("up1");
    expect(phases).toEqual(["preparing", "uploading", "committing"]);
    expect(calls.abortPublish).not.toHaveBeenCalled();
  });

  it("resumes an open upload instead of preparing again", async () => {
    const targets = [target("a", 3)];
    const calls = api(targets);
    await runPublish({
      api: calls,
      transport: scriptedStorage().transport,
      request,
      idempotencyKey: "key-12345",
      objects: objectsFor(targets),
      resume: prepared(targets),
      onPhase: () => {},
      onProgress: () => {},
      signal: new AbortController().signal,
      now: () => NOW,
      sleep: async () => {},
    });
    expect(calls.preparePublish).not.toHaveBeenCalled();
    expect(calls.uploadProgress).toHaveBeenCalledWith("up1");
  });

  it("keeps a failed upload open for resuming and aborts a cancelled one", async () => {
    const targets = [target("a", 3)];
    const calls = api(targets);
    calls.commitPublish.mockRejectedValueOnce(new ApiFailure("upload_incomplete", 409));
    const error = await runPublish({
      api: calls,
      transport: scriptedStorage().transport,
      request,
      idempotencyKey: "key-12345",
      objects: objectsFor(targets),
      onPhase: () => {},
      onProgress: () => {},
      signal: new AbortController().signal,
      now: () => NOW,
    }).catch((e: unknown) => e);
    expect(preparedOf(error)?.uploadId).toBe("up1");
    expect(canResume(error)).toBe(true);
    expect(calls.abortPublish).not.toHaveBeenCalled();

    const controller = new AbortController();
    const cancelling: StorageTransport = {
      put: async () => {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      },
      get: () => Promise.reject(new Error("unused")),
    };
    calls.abortPublish.mockRejectedValueOnce(new ApiFailure("network", 0));
    const cancelled = await runPublish({
      api: calls,
      transport: cancelling,
      request,
      idempotencyKey: "key-12345",
      objects: objectsFor(targets),
      onPhase: () => {},
      onProgress: () => {},
      signal: controller.signal,
      now: () => NOW,
    }).catch((e: unknown) => e);
    expect(cancelled).toBeInstanceOf(UploadCancelled);
    expect(calls.abortPublish).toHaveBeenCalledWith("up1");
    expect(preparedOf("not an error")).toBeUndefined();
  });

  it("attaches the open upload even to failures that are not errors", async () => {
    const calls = api([]);
    calls.commitPublish.mockRejectedValueOnce("boom");
    const error = await runPublish({
      api: calls,
      transport: scriptedStorage().transport,
      request,
      idempotencyKey: "key-12345",
      objects: new Map(),
      onPhase: () => {},
      onProgress: () => {},
      signal: new AbortController().signal,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(preparedOf(error)?.uploadId).toBe("up1");
  });
});

describe("failures", () => {
  const t = (id: string, values?: Record<string, string | number>) =>
    values ? `${id} ${JSON.stringify(values)}` : id;

  it("explains each failure in the terms of its rule", () => {
    expect(publishFailureMessage(t, new UploadFailure("integrity", "a.html"))).toBe(
      'upload.integrity {"path":"a.html"}',
    );
    expect(publishFailureMessage(t, new UploadFailure("missing"))).toBe(
      'upload.missing {"path":""}',
    );
    expect(publishFailureMessage(t, new ApiFailure("quota_exceeded", 429))).toBe(
      "publish.error.quota_exceeded",
    );
    expect(publishFailureMessage(t, new ApiFailure("forbidden", 403))).toBe("error.forbidden");
    expect(publishFailureMessage(t, new Error("x"))).toBe("error.unexpected");
  });

  it("offers resuming only when a retry can help", () => {
    expect(canResume(new UploadFailure("network"))).toBe(true);
    expect(canResume(new UploadFailure("storage"))).toBe(true);
    expect(canResume(new UploadFailure("integrity"))).toBe(false);
    expect(canResume(new ApiFailure("rate_limited", 429))).toBe(true);
    expect(canResume(new ApiFailure("version_conflict", 409))).toBe(false);
    expect(canResume(new ApiFailure("quota_exceeded", 429))).toBe(false);
    expect(canResume(new Error("x"))).toBe(false);
  });
});

function multipart(
  sha: string,
  size: number,
  partSize: number,
  doneParts: number[] = [],
  expiresIn = 600_000,
  sig = "1",
): MultipartUploadTarget {
  const partCount = Math.ceil(size / partSize);
  const parts = [];
  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    if (doneParts.includes(partNumber)) continue;
    const offset = (partNumber - 1) * partSize;
    const partBytes = Math.min(partSize, size - offset);
    parts.push({
      partNumber,
      offset,
      size: partBytes,
      method: "PUT" as const,
      url: `https://storage.test/${sha}/${partNumber}?sig=${sig}`,
      headers: { "content-length": String(partBytes) },
      expiresAt: later(expiresIn),
    });
  }
  return {
    sha256: sha.padEnd(64, "0"),
    size,
    method: "MULTIPART",
    partSize,
    partCount,
    doneParts,
    parts,
  };
}

describe("uploadObjects with multipart targets", () => {
  it("sends each part as a slice of the file, reports its ETag and counts the object once", async () => {
    const big = multipart("m", 10, 4);
    const small = target("s", 2);
    const sizes: number[] = [];
    const { transport, calls } = scriptedStorage();
    const put = transport.put;
    transport.put = (request, body, onProgress, signal) => {
      sizes.push(body.size);
      return put(request, body, onProgress, signal);
    };
    const progress: UploadProgress[] = [];
    const run = job([big, small], transport, {
      onProgress: (p: UploadProgress) => progress.push(p),
    });
    await uploadObjects(run);
    expect(calls.sort()).toEqual([
      "https://storage.test/m/1?sig=1",
      "https://storage.test/m/2?sig=1",
      "https://storage.test/m/3?sig=1",
      "https://storage.test/s?sig=1",
    ]);
    // Parts are slices of at most the part size, never the whole file.
    expect(sizes.sort()).toEqual([2, 2, 4, 4]);
    expect(
      run.api.reportPart.mock.calls
        .map(([, part]) => part)
        .sort((a, b) => a.partNumber - b.partNumber),
    ).toEqual([
      { sha256: big.sha256, partNumber: 1, etag: '"etag-https://storage.test/m/1?sig=1"' },
      { sha256: big.sha256, partNumber: 2, etag: '"etag-https://storage.test/m/2?sig=1"' },
      { sha256: big.sha256, partNumber: 3, etag: '"etag-https://storage.test/m/3?sig=1"' },
    ]);
    expect(progress.at(-1)).toEqual({
      sentBytes: 12,
      totalBytes: 12,
      doneObjects: 2,
      totalObjects: 2,
    });
  });

  it("resumes with only the parts not done and counts the done ones as sent", async () => {
    const big = multipart("m", 10, 4, [1, 2]);
    const { transport, calls } = scriptedStorage();
    const progress: UploadProgress[] = [];
    await uploadObjects(
      job([big], transport, { onProgress: (p: UploadProgress) => progress.push(p) }),
    );
    expect(calls).toEqual(["https://storage.test/m/3?sig=1"]);
    expect(progress[0]).toMatchObject({ sentBytes: 8, totalBytes: 10 });
    expect(progress.at(-1)).toMatchObject({ sentBytes: 10, doneObjects: 1 });
  });

  it("gets fresh part URLs once after storage refuses an expired signature", async () => {
    const stale = multipart("m", 8, 4);
    const fresh = multipart("m", 8, 4, [1], 600_000, "2");
    const { transport, calls } = scriptedStorage({ "https://storage.test/m/2?sig=1": [403] });
    const run = job([stale], transport);
    run.api.uploadProgress.mockResolvedValue(prepared([fresh]));
    await uploadObjects(run);
    expect(run.api.uploadProgress).toHaveBeenCalledTimes(1);
    expect(calls).toContain("https://storage.test/m/2?sig=2");
    expect(run.api.reportPart).toHaveBeenCalledTimes(2);
  });

  it("fails when storage stores a part but its ETag cannot be read", async () => {
    const big = multipart("m", 4, 4);
    const transport: StorageTransport = {
      put: async () => ({ status: 200, etag: null }),
      get: () => Promise.reject(new Error("unused")),
    };
    const run = job([big], transport);
    await expect(uploadObjects(run)).rejects.toMatchObject({ reason: "storage" });
    expect(run.api.reportPart).not.toHaveBeenCalled();
  });
});
