// Load and concurrency scenarios (plan section 16: "Carga máxima", "Concurrencia",
// "Rendimiento"). Each one drives the public API like a client would and reports measurements
// plus the expectations it checked; a failed expectation fails the run.
import { createHash, randomUUID } from "node:crypto";
import type { Body, Sent } from "./http.ts";
import { patternChunks, splitBytes, summarize, tally } from "./measure.ts";
import type { LoadOptions, Scenario } from "./options.ts";
import type { Auth, Target } from "./target.ts";

const MAX_ARTIFACT_BYTES = 250_000_000;
const ACTIVE_SLOTS = 50;
const WRITES_PER_MINUTE = 5;
/** First comments on other people's artifacts that need a human check (ANNOTATION_LIMITS). */
const HUMAN_CHECKED_COMMENTS = 3;
const SESSION_COOKIE = "__Host-pf.session_token";

export interface Expectation {
  label: string;
  ok: boolean;
}

export interface ScenarioResult {
  scenario: Scenario;
  ok: boolean;
  skipped?: string;
  metrics: Record<string, unknown>;
  expectations: Expectation[];
}

interface Json {
  status: number;
  body: Record<string, unknown>;
}

/** A file of a publish whose bytes are generated on demand and never kept in memory. */
interface SourceFile {
  path: string;
  contentType: string;
  size: number;
  sha256: string;
  chunks(): Iterable<Uint8Array>;
}

function textFile(path: string, text: string, contentType = "text/html"): SourceFile {
  const bytes = new TextEncoder().encode(text);
  return {
    path,
    contentType,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    chunks: () => [bytes],
  };
}

function generatedFile(path: string, seed: number, size: number): SourceFile {
  const hash = createHash("sha256");
  for (const chunk of patternChunks(seed, size)) hash.update(chunk);
  return {
    path,
    contentType: "application/octet-stream",
    size,
    sha256: hash.digest("hex"),
    chunks: () => patternChunks(seed, size),
  };
}

// No constructor parameter properties: Node runs this file with type stripping only.
export class Api {
  readonly target: Target;
  readonly auth: Auth;

  constructor(target: Target, auth: Auth) {
    this.target = target;
    this.auth = auth;
  }

  headers(method: string): Record<string, string> {
    if (this.auth.kind === "bearer") return { authorization: `Bearer ${this.auth.token}` };
    // A dashboard session request, as the browser sends it from the app's own pages.
    return {
      cookie: `${SESSION_COOKIE}=${this.auth.cookie}`,
      "sec-fetch-site": "same-origin",
      ...(method === "GET" ? {} : { origin: this.target.appOrigin }),
    };
  }

  async call(method: string, path: string, body?: unknown): Promise<Json & { ms: number }> {
    const headers: Record<string, string> = { ...this.headers(method) };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method === "POST") headers["idempotency-key"] = randomUUID();
    const sent = await this.target.request({
      method,
      url: `${this.target.appOrigin}${path}`,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: sent.status, body: parseJson(sent), ms: sent.ms };
  }
}

function parseJson(sent: Sent): Record<string, unknown> {
  try {
    const value = JSON.parse(sent.body.toString("utf8")) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function errorCode(json: Json): string {
  const error = json.body.error as { code?: unknown } | undefined;
  return typeof error?.code === "string" ? error.code : `http_${json.status}`;
}

interface PublishOutcome {
  ok: boolean;
  stage: "prepare" | "upload" | "commit" | "done";
  code: string | null;
  artifactId: string | null;
  ms: { prepare: number; upload: number; commit: number };
}

/** prepare, presigned uploads and commit, exactly as the CLI and the dashboard publish. */
async function publish(
  target: Target,
  api: Api,
  name: string,
  files: SourceFile[],
  uploadsAtOnce = 2,
): Promise<PublishOutcome> {
  const ms = { prepare: 0, upload: 0, commit: 0 };
  const prepared = await api.call("POST", "/api/v1/publishes", {
    type: "site",
    name,
    entrypoint: files[0]?.path,
    baseVersionId: null,
    files: files.map(({ path, contentType, size, sha256 }) => ({
      path,
      kind: "published",
      sha256,
      size,
      contentType,
    })),
  });
  ms.prepare = prepared.ms;
  if (prepared.status !== 201) {
    return { ok: false, stage: "prepare", code: errorCode(prepared), artifactId: null, ms };
  }
  const artifactId = String(prepared.body.artifactId);
  const uploads = prepared.body.uploads as {
    sha256: string;
    url: string;
    headers: Record<string, string>;
  }[];
  const bySha = new Map(files.map((file) => [file.sha256, file]));
  const started = performance.now();
  const queue = [...uploads];
  let failure: string | null = null;
  await Promise.all(
    Array.from({ length: Math.min(uploadsAtOnce, queue.length) }, async () => {
      for (let next = queue.shift(); next && !failure; next = queue.shift()) {
        const file = bySha.get(next.sha256);
        if (!file) throw new Error(`The server asked for an unknown object ${next.sha256}`);
        const sent = await target.upload(next.url, next.headers, file.chunks() as Body);
        if (sent.status !== 200) failure = `upload_${sent.status}`;
      }
    }),
  );
  ms.upload = performance.now() - started;
  if (failure) return { ok: false, stage: "upload", code: failure, artifactId, ms };
  const committed = await api.call(
    "POST",
    `/api/v1/publishes/${prepared.body.uploadId}/commit`,
    {},
  );
  ms.commit = committed.ms;
  if (committed.status !== 200) {
    return { ok: false, stage: "commit", code: errorCode(committed), artifactId, ms };
  }
  return { ok: true, stage: "done", code: null, artifactId, ms };
}

interface Meter {
  used: number;
  limit: number;
}

/** The fields of GET /api/v1/usage the scenarios read. */
interface Usage {
  activeArtifacts: Meter;
  storage: Meter;
  openUploads: Meter;
}

async function usage(api: Api): Promise<Usage> {
  const result = await api.call("GET", "/api/v1/usage");
  if (result.status !== 200) throw new Error(`GET /api/v1/usage answered ${result.status}`);
  return result.body as unknown as Usage;
}

function bearer(): Auth {
  const token = process.env.PORTIFACT_LOAD_TOKEN;
  if (!token) throw new Error("Set PORTIFACT_LOAD_TOKEN to run against a remote target.");
  return { kind: "bearer", token };
}

async function owner(target: Target, label: string): Promise<{ api: Api; userId: string | null }> {
  if (!target.seed) return { api: new Api(target, bearer()), userId: null };
  const user = await target.seed.user(`${label}-${randomUUID().slice(0, 8)}@load.test`);
  return { api: new Api(target, user.auth), userId: user.userId };
}

function result(
  scenario: Scenario,
  metrics: Record<string, unknown>,
  expectations: Expectation[],
): ScenarioResult {
  return { scenario, ok: expectations.every((e) => e.ok), metrics, expectations };
}

/** Concurrent publishes of new artifacts when one active slot is left. */
async function quotaRace(target: Target, options: LoadOptions): Promise<ScenarioResult> {
  const { api, userId } = await owner(target, "quota");
  if (target.seed && userId) {
    for (let i = 0; i < ACTIVE_SLOTS - 1; i++) {
      await target.seed.publish({
        ownerId: userId,
        name: `Filler ${i}`,
        files: { "index.html": `<h1>Filler ${i}</h1>` },
      });
    }
  }
  const before = await usage(api);
  const free = before.activeArtifacts.limit - before.activeArtifacts.used;
  const started = performance.now();
  const outcomes = await Promise.all(
    Array.from({ length: options.publishers }, (_, i) =>
      publish(target, api, `Race ${i}`, [
        textFile("index.html", `<h1>Race ${i} ${randomUUID()}</h1>`),
      ]),
    ),
  );
  const wallMs = performance.now() - started;
  const after = await usage(api);
  const committed = outcomes.filter((outcome) => outcome.ok).length;
  const refusals = tally(outcomes.filter((o) => !o.ok).map((o) => `${o.stage}:${o.code}`));
  const expectations: Expectation[] = [
    {
      label: `at most ${free} of ${options.publishers} racing publishes commit`,
      ok: committed <= free,
    },
    {
      label: `active artifacts stay within ${after.activeArtifacts.limit}`,
      ok: after.activeArtifacts.used <= after.activeArtifacts.limit,
    },
    {
      label: "refused publishes fail with quota_exceeded and leave no open upload",
      ok:
        Object.keys(refusals).every((key) => key === "prepare:quota_exceeded") &&
        after.openUploads.used === 0,
    },
  ];
  if (target.seed) {
    expectations.push({ label: "exactly one publish takes the last slot", ok: committed === 1 });
    expectations.push({
      label: "the account ends with exactly 50 active artifacts",
      ok: after.activeArtifacts.used === ACTIVE_SLOTS,
    });
  }
  return result(
    "quota-race",
    {
      publishers: options.publishers,
      freeSlotsBefore: free,
      committed,
      refusals,
      activeAfter: after.activeArtifacts.used,
      wallMs: Math.round(wallMs),
      createdArtifacts: target.seed
        ? undefined
        : outcomes.filter((o) => o.ok).map((o) => o.artifactId),
    },
    expectations,
  );
}

/** A publish of exactly 250 MB through presigned uploads, with memory sampled throughout. */
async function maxUpload(target: Target): Promise<ScenarioResult> {
  const { api } = await owner(target, "max");
  const seed = Date.now() >>> 0;
  const index = textFile("index.html", "<!doctype html><title>Maximum size</title>");
  // Each object stays under 64 MiB, the size above which the plan calls for multipart uploads.
  const sizes = splitBytes(MAX_ARTIFACT_BYTES - index.size, 4);
  const hashStarted = performance.now();
  const blobs = sizes.map((size, i) => generatedFile(`blob-${i}.bin`, seed + i, size));
  const hashMs = performance.now() - hashStarted;
  const files = [index, ...blobs];

  // One byte over the limit is refused before any upload starts.
  const over = await api.call("POST", "/api/v1/publishes", {
    type: "site",
    name: "Over the limit",
    entrypoint: "index.html",
    baseVersionId: null,
    files: [...files, textFile("one-more.txt", "x", "text/plain")].map(
      ({ path, contentType, size, sha256 }) => ({
        path,
        kind: "published",
        sha256,
        size,
        contentType,
      }),
    ),
  });

  const baseline = target.memoryBytes();
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, target.memoryBytes());
  }, 100);
  const outcome = await publish(target, api, "Maximum size", files).finally(() =>
    clearInterval(sampler),
  );
  peak = Math.max(peak, target.memoryBytes());
  const after = await usage(api);
  const growth = peak - baseline;
  const mb = (bytes: number) => Math.round(bytes / 1e6);
  const uploadSeconds = outcome.ms.upload / 1000;
  return result(
    "max-upload",
    {
      publishedBytes: MAX_ARTIFACT_BYTES,
      objects: files.length,
      hashMs: Math.round(hashMs),
      prepareMs: Math.round(outcome.ms.prepare),
      uploadMs: Math.round(outcome.ms.upload),
      uploadMBps: uploadSeconds > 0 ? Math.round(MAX_ARTIFACT_BYTES / 1e6 / uploadSeconds) : null,
      commitMs: Math.round(outcome.ms.commit),
      memoryBaselineMB: mb(baseline),
      memoryPeakMB: mb(peak),
      memoryGrowthMB: mb(growth),
      outcome: outcome.ok ? "committed" : `${outcome.stage}:${outcome.code}`,
      artifactId: outcome.artifactId,
    },
    [
      {
        label: "a version one byte over 250 MB is refused at prepare",
        ok: over.status >= 400 && over.status < 500,
      },
      { label: "the 250 MB publish commits", ok: outcome.ok },
      {
        label: "storage counts the whole version",
        ok: after.storage.used >= MAX_ARTIFACT_BYTES,
      },
      {
        // The client streams and the server verifies objects in place. Two objects of about
        // 62.5 MB upload at once, so growth must stay below the payload: nothing may hold the
        // whole publish in memory.
        label: "memory grows by less than the payload while uploading",
        ok: growth < MAX_ARTIFACT_BYTES,
      },
    ],
  );
}

async function deliveryArtifact(
  target: Target,
  options: LoadOptions,
): Promise<{ artifactId: string; paths: string[] }> {
  if (!target.seed) return { artifactId: options.artifact as string, paths: ["/"] };
  const { userId } = await owner(target, "delivery");
  const html = `<!doctype html><title>Delivery</title><script src="app.js"></script>${"<p>Lorem ipsum dolor sit amet.</p>".repeat(300)}`;
  const { artifactId } = await target.seed.publish({
    ownerId: userId as string,
    name: "Delivery",
    files: { "index.html": html, "app.js": `console.log(${"1+".repeat(2000)}1);` },
    accessMode: "public",
  });
  return { artifactId, paths: ["/", "/app.js"] };
}

/** Throughput of a published public site, with the fetch metadata a browser sends. */
async function delivery(target: Target, options: LoadOptions): Promise<ScenarioResult> {
  const { artifactId, paths } = await deliveryArtifact(target, options);
  const origin = `https://${artifactId}.${target.contentDomain}`;
  const latencies: number[] = [];
  const statuses: number[] = [];
  let bytes = 0;
  let errors = 0;
  const deadline = performance.now() + options.durationSeconds * 1000;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: options.concurrency }, async (_, worker) => {
      for (let i = worker; performance.now() < deadline; i++) {
        const path = paths[i % paths.length] as string;
        const page = path === "/";
        try {
          const sent = await target.request({
            method: "GET",
            url: `${origin}${path}`,
            headers: {
              "sec-fetch-site": page ? "none" : "same-origin",
              "sec-fetch-mode": page ? "navigate" : "no-cors",
              "sec-fetch-dest": page ? "document" : "script",
            },
            discardBody: true,
          });
          latencies.push(sent.ms);
          statuses.push(sent.status);
          bytes += Number(sent.headers["content-length"] ?? 0);
        } catch {
          errors++;
        }
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  const ok = statuses.filter((status) => status === 200).length;
  return result(
    "delivery",
    {
      artifactId,
      concurrency: options.concurrency,
      seconds: Math.round(seconds * 10) / 10,
      requests: statuses.length,
      requestsPerSecond: Math.round(statuses.length / seconds),
      megabytesPerSecond: Math.round((bytes / 1e6 / seconds) * 10) / 10,
      latency: summarize(latencies),
      statuses: tally(statuses),
      networkErrors: errors,
    },
    [
      { label: "the site answers requests", ok: statuses.length > 0 },
      {
        label: "at least 99% of requests succeed",
        ok: statuses.length > 0 && ok / (statuses.length + errors) >= 0.99,
      },
    ],
  );
}

/** Bursts of thread writes from several authors at once against the per-author rate limit. */
async function annotations(target: Target, options: LoadOptions): Promise<ScenarioResult> {
  let artifactId: string;
  let versionId: string;
  let authors: Api[];
  if (target.seed) {
    const owner = await target.seed.user(`owner-${randomUUID().slice(0, 8)}@load.test`);
    const users = await Promise.all(
      Array.from({ length: options.authors }, (_, i) =>
        target.seed?.user(`author-${i}-${randomUUID().slice(0, 8)}@load.test`),
      ),
    );
    const published = await target.seed.publish({
      ownerId: owner.userId,
      name: "Annotations",
      files: { "index.html": "<h1>Review me</h1>" },
      readers: users.map((user) => user?.email ?? ""),
      annotations: "open",
    });
    ({ artifactId, versionId } = published);
    authors = users.map((user) => new Api(target, user?.auth as Auth));
    // An account's first comments on other people's artifacts need a solved human check, which
    // a load test cannot do. Earlier comments, written before the rate-limit minute, clear it.
    const seed = target.seed;
    for (const user of users) {
      for (let i = 0; i < HUMAN_CHECKED_COMMENTS; i++) {
        await seed.thread({
          userId: user?.userId as string,
          artifactId,
          versionId,
          body: `Earlier note ${i}`,
          agoMs: 2 * 60_000,
        });
      }
    }
  } else {
    artifactId = options.artifact as string;
    authors = [new Api(target, bearer())];
    const listed = await (authors[0] as Api).call(
      "GET",
      `/api/v1/artifacts/${artifactId}/annotations?limit=1`,
    );
    versionId = String(listed.body.currentVersionId);
  }

  const started = performance.now();
  const outcomes = await Promise.all(
    authors.flatMap((author, a) =>
      Array.from({ length: options.writes }, (_, w) =>
        author
          .call("POST", `/api/v1/artifacts/${artifactId}/annotations/threads`, {
            versionId,
            target: { schema: 1, path: "index.html", anchor: { kind: "document" } },
            body: `Load test note ${a}.${w}`,
          })
          .then((json) => ({ author: a, json })),
      ),
    ),
  );
  const wallMs = performance.now() - started;
  const accepted = (a: number) =>
    outcomes.filter((o) => o.author === a && o.json.status === 201).length;
  const perAuthor = authors.map((_, a) => accepted(a));
  const expected = Math.min(options.writes, WRITES_PER_MINUTE);
  const codes = tally(outcomes.map((o) => (o.json.status === 201 ? 201 : errorCode(o.json))));
  const expectations: Expectation[] = [
    {
      label: `no author gets more than ${WRITES_PER_MINUTE} writes in a minute`,
      ok: perAuthor.every((count) => count <= WRITES_PER_MINUTE),
    },
    {
      label: "every refusal is a rate limit",
      ok: Object.keys(codes).every((code) => code === "201" || code === "rate_limited"),
    },
  ];
  if (target.seed) {
    const [row] = await target.seed.sql(
      "SELECT count(*) AS threads FROM annotation_threads WHERE artifact_id = ?",
      [artifactId],
    );
    const stored = Number(row?.threads ?? -1) - options.authors * HUMAN_CHECKED_COMMENTS;
    expectations.push({
      label: `each of ${options.authors} authors gets exactly ${expected} writes`,
      ok: perAuthor.every((count) => count === expected),
    });
    expectations.push({
      label: "the stored threads match the accepted writes",
      ok: stored === perAuthor.reduce((sum, count) => sum + count, 0),
    });
  }
  return result(
    "annotations",
    {
      authors: authors.length,
      writesPerAuthor: options.writes,
      acceptedPerAuthor: perAuthor,
      answers: tally(outcomes.map((o) => o.json.status)),
      codes,
      wallMs: Math.round(wallMs),
      latency: summarize(outcomes.map((o) => o.json.ms)),
    },
    expectations,
  );
}

export async function runScenario(
  scenario: Scenario,
  target: Target,
  options: LoadOptions,
): Promise<ScenarioResult> {
  switch (scenario) {
    case "quota-race":
      return quotaRace(target, options);
    case "max-upload":
      return maxUpload(target);
    case "delivery":
      return delivery(target, options);
    case "annotations":
      return annotations(target, options);
  }
}
