import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ByteRange } from "./runtime.ts";
import { sha256Of } from "./testing/fake-api.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";
import { UPLOAD_CONCURRENCY } from "./upload.ts";

let server: FakeServer;
let h: Harness;

/** Tiny thresholds so a test file goes in parts; the real ones are 64 MiB and 16 MiB. */
const THRESHOLD = 64;
const PART = 32;

beforeEach(async () => {
  server = await startFakeServer();
  h = await createHarness({ server });
  server.api.multipart = { thresholdBytes: THRESHOLD, partBytes: PART };
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

function data(size: number): Buffer {
  return Buffer.from(Array.from({ length: size }, (_, i) => (i * 13) & 255));
}

/** Records every file body the CLI opens and the part uploads in flight at once. */
function watch() {
  const bodies: { path: string; range: ByteRange | undefined }[] = [];
  const realBody = h.runtime.fileBody;
  h.runtime.fileBody = (path, range) => {
    bodies.push({ path, range });
    return realBody(path, range);
  };
  let inFlight = 0;
  let peak = 0;
  const realFetch = h.runtime.fetch;
  h.runtime.fetch = async (input, init) => {
    const isPart = String(input).includes("/r2/parts/");
    if (isPart) peak = Math.max(peak, ++inFlight);
    try {
      return await realFetch(input, init);
    } finally {
      if (isPart) inFlight -= 1;
    }
  };
  return { bodies, peak: () => peak };
}

function stored(sha: string): Buffer | undefined {
  return server.api.stored.get(sha);
}

describe("multipart uploads from the CLI", () => {
  it("streams a large file in parts with bounded concurrency, reports them and commits", async () => {
    h.signIn();
    const large = data(5 * PART - 10);
    const folder = await h.files("big", { "index.html": "<p>Big</p>", "data.bin": large });
    const seen = watch();

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(0);
    const prepare = server.requests.find(
      (r) => r.method === "POST" && r.path === "/api/v1/publishes",
    );
    expect(JSON.parse(prepare?.body ?? "{}").multipart).toBe(true);
    expect(stored(sha256Of(large))).toEqual(large);
    expect(server.api.partPuts.map((put) => [put.partNumber, put.bytes, put.status])).toEqual(
      expect.arrayContaining([
        [1, PART, 200],
        [2, PART, 200],
        [3, PART, 200],
        [4, PART, 200],
        [5, PART - 10, 200],
      ]),
    );
    expect(server.api.partReports.map((report) => report.partNumber).sort()).toEqual([
      1, 2, 3, 4, 5,
    ]);
    // Memory stays bounded: the large file is only ever opened one part-sized range at a time.
    const largeBodies = seen.bodies.filter((body) => body.path.endsWith("data.bin"));
    expect(largeBodies).toHaveLength(5);
    for (const body of largeBodies) {
      expect(body.range).toBeDefined();
      expect((body.range?.end ?? 0) - (body.range?.start ?? 0)).toBeLessThanOrEqual(PART);
    }
    expect(seen.peak()).toBeLessThanOrEqual(UPLOAD_CONCURRENCY);
    expect(result.stderr).toContain("Uploaded part 1 of 5 of data.bin");
    expect(result.stderr).toContain("Uploaded 2 of 2");
  });

  it("uploads a file of exactly the threshold in one request and a larger one in parts", async () => {
    h.signIn();
    const exact = data(THRESHOLD);
    const over = Buffer.concat([data(THRESHOLD), Buffer.from([7])]);
    const folder = await h.files("edge", { "index.html": exact, "over.bin": over });

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(0);
    expect(server.api.puts.map((put) => put.sha256)).toEqual([sha256Of(exact)]);
    expect(new Set(server.api.partPuts.map((put) => put.sha256))).toEqual(
      new Set([sha256Of(over)]),
    );
    expect(server.api.partPuts).toHaveLength(3);
    expect(stored(sha256Of(over))).toEqual(over);
  });

  it("resumes after an expired part URL, sending only the parts not reported yet", async () => {
    h.signIn();
    const large = data(4 * PART);
    const folder = await h.files("resume", { "index.html": "<p>R</p>", "data.bin": large });
    server.faults.push({
      method: "PUT",
      path: /^\/r2\/parts\/[0-9a-f]+\/4$/,
      reply: { status: 403, body: "Request has expired" },
    });

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(0);
    const renewals = server.requests.filter(
      (r) => r.method === "GET" && /^\/api\/v1\/publishes\/[^/]+$/.test(r.path),
    );
    expect(renewals).toHaveLength(1);
    // Each part reached storage once; only the refused one was sent again.
    const sent = server.requests
      .filter((r) => r.method === "PUT")
      .map((r) => r.path.split("/").pop());
    expect(sent.filter((part) => part === "4")).toHaveLength(2);
    for (const part of ["1", "2", "3"]) expect(sent.filter((p) => p === part)).toHaveLength(1);
    expect(stored(sha256Of(large))).toEqual(large);
  });

  it("retries a part after a transient storage failure", async () => {
    h.signIn();
    const large = data(3 * PART);
    const folder = await h.files("flaky", { "index.html": "<p>F</p>", "data.bin": large });
    server.faults.push({ method: "PUT", path: /^\/r2\/parts\//, reply: { status: 503 } });

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(0);
    expect(h.sleeps).toEqual([1000]);
    expect(stored(sha256Of(large))).toEqual(large);
  });

  it("fails and cancels the upload when storage answers a part without its ETag", async () => {
    h.signIn();
    server.api.hideEtag = true;
    const folder = await h.files("cors", { "index.html": "<p>C</p>", "data.bin": data(3 * PART) });

    const result = await h.invoke("publish", folder, "--json");

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("upload_failed");
    expect([...server.api.sessions.values()][0]?.state).toBe("aborted");
    expect(server.api.partReports).toEqual([]);
  });

  it("uploads every file in one request to a server without multipart", async () => {
    h.signIn();
    server.api.multipart = null;
    const large = data(3 * PART);
    const folder = await h.files("old", { "index.html": "<p>O</p>", "data.bin": large });

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(0);
    expect(server.api.partPuts).toEqual([]);
    expect(stored(sha256Of(large))).toEqual(large);
  });
});
