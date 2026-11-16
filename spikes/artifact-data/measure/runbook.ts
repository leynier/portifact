// Runbook for decision 0026's delivery 8 measurements on a temporary deployment. Run by the
// maintainer's agent with the deploy credentials, never by CI. It deploys only a Worker named
// `pf-exp-data-<run>` that exports the production documents object (`measure/worker.ts`), drives
// realistic and hostile workloads through it, one phase per minute-aligned window, reads Cloudflare's
// GraphQL analytics for the phases and the jobs Worker's collector queries, prints the figures in
// the record's units, and always deletes the objects and the Worker.
//
//   CLOUDFLARE_ACCOUNT_ID=<id> node spikes/artifact-data/measure/runbook.ts run
//   CLOUDFLARE_ACCOUNT_ID=<id> node spikes/artifact-data/measure/runbook.ts report --state <file>
//   CLOUDFLARE_ACCOUNT_ID=<id> node spikes/artifact-data/measure/runbook.ts cleanup --state <file>
//
// The API token is `CLOUDFLARE_API_TOKEN` or wrangler's own login (`wrangler auth token`), read
// into memory and never printed. Options of `run`: --run <suffix>, --skip-alarms (no quiet tail),
// --only fixes (only the sparse and live fan-out phases).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  alreadyGone,
  type Dataset,
  DELETION_ENTRY,
  datasetQuery,
  datasets,
  deletionConfig,
  floorMinute,
  guardName,
  nextPhaseStart,
  phaseEnd,
  round,
  runSuffix,
  table,
  totals,
  windowFor,
  workersDevUrl,
} from "../src/runbook-plan.ts";

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Window {
  phase: string;
  start: string;
  end: string;
  commands: number;
  note?: string;
}

interface State {
  run: string;
  accountId: string;
  worker: string;
  dir: string;
  url?: string | undefined;
  token: string;
  namespaceId?: string | undefined;
  artifacts: Record<string, string>;
  windows: Window[];
  alarmAt?: string;
  results: Record<string, unknown>;
  created: boolean;
}

const here = fileURLToPath(new URL(".", import.meta.url));
const wranglerBin = join(here, "..", "node_modules", ".bin", "wrangler");
const log = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function args(argv: string[]): { command: string; options: Record<string, string> } {
  const [command = "help", ...rest] = argv;
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index] ?? "";
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) options[key.slice(2)] = "true";
    else {
      options[key.slice(2)] = next;
      index += 1;
    }
  }
  return { command, options };
}

function wrangler(state: State, argv: string[], input?: string) {
  const result = spawnSync(wranglerBin, argv, {
    cwd: state.dir,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: state.accountId, CI: "true" },
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

let cachedToken: string | undefined;
function apiToken(state: State): string {
  if (cachedToken) return cachedToken;
  const fromEnv = process.env.CLOUDFLARE_API_TOKEN;
  if (fromEnv) {
    cachedToken = fromEnv;
    return fromEnv;
  }
  const out = wrangler(state, ["auth", "token"]);
  const line = out.output
    .trim()
    .split("\n")
    .map((part) => part.trim())
    .filter((part) => /^[A-Za-z0-9._-]{40,}$/.test(part))
    .pop();
  if (!out.ok || !line)
    throw new Error("no API token: log wrangler in or set CLOUDFLARE_API_TOKEN");
  cachedToken = line;
  return line;
}

function save(state: State): void {
  const file = join(state.dir, "state.json");
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

function load(file: string): State {
  const state = JSON.parse(readFileSync(file, "utf8")) as State;
  if (guardName(state.worker) !== `pf-exp-data-${runSuffix(state.run)}`) {
    throw new Error("state file names differ");
  }
  return state;
}

/** An artifact ID in the product's shape (`[a-z2-7]{10}`). */
function artifactId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return [...randomBytes(10)].map((byte) => alphabet[byte % 32]).join("");
}

async function call<T>(state: State, path: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${state.url}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return (await response.json()) as T;
    if (attempt < 10 && (response.status === 404 || response.status >= 500)) {
      await sleep(3_000);
      continue;
    }
    throw new Error(
      `${path} answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
}

interface Tally {
  ok: number;
  refused: Record<string, number>;
  rowsRead: number;
  rowsWritten: number;
  bytes: number;
  ids: string[];
  ms: number;
}

/**
 * One kind of command, `count` times, in calls of at most 100 so the driver stays inside the data
 * Worker's 200 ms CPU limit, which the scratch Worker keeps; bulk removals pass their own index.
 */
async function step(state: State, input: Record<string, unknown>): Promise<Tally> {
  const count = Number(input.count ?? 1);
  const out: Tally = { ok: 0, refused: {}, rowsRead: 0, rowsWritten: 0, bytes: 0, ids: [], ms: 0 };
  for (let done = 0; done < count; done += 100) {
    const one = await call<Tally>(state, "/step", {
      ...input,
      count: Math.min(100, count - done),
      ...(input.kind === "owner_bulk_remove"
        ? { ids: (input.ids as string[]).slice(done * Number(input.bulk ?? 100)) }
        : {}),
    });
    out.ok += one.ok;
    for (const [code, n] of Object.entries(one.refused))
      out.refused[code] = (out.refused[code] ?? 0) + n;
    out.rowsRead += one.rowsRead;
    out.rowsWritten += one.rowsWritten;
    out.bytes = Math.max(out.bytes, one.bytes);
    out.ids.push(...one.ids);
    out.ms += one.ms;
  }
  return out;
}

async function deploy(state: State): Promise<void> {
  const config = join(state.dir, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify(
      {
        name: guardName(state.worker),
        main: join(here, "worker.ts"),
        compatibility_date: "2026-08-01",
        compatibility_flags: ["nodejs_compat"],
        workers_dev: true,
        // The production data Worker's own limit (decision 0026, "Engineering choices").
        limits: { cpu_ms: 200 },
        durable_objects: { bindings: [{ name: "DOCUMENTS", class_name: "ArtifactDocuments" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["ArtifactDocuments"] }],
      },
      null,
      2,
    ),
  );
  state.created = true;
  save(state);
  const deployed = wrangler(state, ["deploy", "--config", config]);
  if (!deployed.ok) throw new Error(`deploy failed:\n${deployed.output.slice(-2000)}`);
  state.url = workersDevUrl(deployed.output) ?? undefined;
  if (!state.url) throw new Error("deploy printed no workers.dev URL");
  const secret = wrangler(
    state,
    ["secret", "put", "MEASURE_TOKEN", "--config", config],
    state.token,
  );
  if (!secret.ok) throw new Error("setting the access token failed");
  save(state);
  log(`deployed ${state.worker}`);
}

async function namespaceOf(state: State): Promise<string | undefined> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${state.accountId}/workers/durable_objects/namespaces?per_page=1000`,
    { headers: { Authorization: `Bearer ${apiToken(state)}` } },
  );
  const body = (await response.json()) as { result?: { id: string; script?: string }[] };
  return body.result?.find((namespace) => namespace.script === state.worker)?.id;
}

async function phase(
  state: State,
  name: string,
  commands: number,
  work: () => Promise<unknown>,
): Promise<void> {
  await sleep(Math.max(0, nextPhaseStart(Date.now()) - Date.now()));
  const start = new Date(floorMinute(Date.now()));
  const result = await work();
  const end = new Date(phaseEnd(Date.now()));
  state.windows.push({ phase: name, start: start.toISOString(), end: end.toISOString(), commands });
  state.results[name] = result;
  save(state);
  const summary = result as Partial<Tally> | undefined;
  log(
    `phase ${name}: ${commands} command(s) ${start.toISOString()} to ${end.toISOString()}${
      summary && typeof summary === "object" && "ok" in summary
        ? ` ok ${summary.ok} refused ${JSON.stringify(summary.refused)} measured rows ${summary.rowsRead}/${summary.rowsWritten} bytes ${summary.bytes}`
        : ` ${JSON.stringify(result).slice(0, 300)}`
    }`,
  );
}

/** Paced commands: one HTTP call each, `spacingMs` apart, so the object hibernates between them. */
async function paced(
  state: State,
  input: Record<string, unknown>,
  count: number,
  spacingMs: number,
): Promise<Tally> {
  const out: Tally = { ok: 0, refused: {}, rowsRead: 0, rowsWritten: 0, bytes: 0, ids: [], ms: 0 };
  for (let index = 0; index < count; index++) {
    // Each command by its own author, on that author's document when the phase names IDs.
    const ids = input.ids as string[] | undefined;
    const one = await step(state, {
      ...input,
      count: 1,
      authorBase: index,
      ...(ids === undefined ? {} : { ids: [ids[index % ids.length]] }),
    });
    out.ok += one.ok;
    for (const [code, n] of Object.entries(one.refused))
      out.refused[code] = (out.refused[code] ?? 0) + n;
    out.rowsRead += one.rowsRead;
    out.rowsWritten += one.rowsWritten;
    out.bytes = Math.max(out.bytes, one.bytes);
    out.ids.push(...one.ids);
    if (index < count - 1) await sleep(spacingMs);
  }
  return out;
}

interface Socket {
  socket: WebSocket;
  socketId: string;
  author: number;
  received: number;
  closed: number | null;
}

async function openSocket(
  state: State,
  artifact: string,
  author: number,
  plan: string,
  real = false,
): Promise<Socket> {
  const url = new URL(`${state.url?.replace("https://", "wss://")}/live`);
  url.searchParams.set("artifact", artifact);
  url.searchParams.set("author", String(author));
  url.searchParams.set("plan", plan);
  if (real) url.searchParams.set("real", "true");
  url.searchParams.set("token", state.token);
  const socket = new WebSocket(url);
  const entry: Socket = { socket, socketId: "", author, received: 0, closed: null };
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      entry.received += 1;
      const data = JSON.parse(String(event.data)) as { connected?: string };
      if (data.connected) {
        entry.socketId = data.connected;
        resolve();
      }
    });
    socket.addEventListener("close", (event) => {
      entry.closed = event.code;
      resolve();
    });
    socket.addEventListener("error", () => reject(new Error("live connection failed")), {
      once: true,
    });
  });
  // The shared board: every connection sees every author's changes (in `own` only its own).
  socket.send(JSON.stringify({ subscribe: "board" }));
  return entry;
}

/** Keeps sockets open for `ms`, renewing each every 45 seconds as the page does. */
async function holdOpen(
  state: State,
  artifact: string,
  plan: string,
  sockets: Socket[],
  ms: number,
  during?: () => Promise<void>,
): Promise<number> {
  let renewals = 0;
  const end = Date.now() + ms;
  const renewer = (async () => {
    while (Date.now() + 45_000 < end) {
      await sleep(45_000);
      for (const entry of sockets) {
        if (entry.closed !== null) continue;
        await call(state, "/renew", {
          artifact,
          plan,
          author: entry.author,
          socketId: entry.socketId,
        });
        renewals += 1;
      }
    }
  })();
  if (during) await during();
  await sleep(Math.max(0, end - Date.now()));
  await renewer;
  for (const entry of sockets) entry.socket.close();
  return renewals;
}

/** Sparse use: one command every 15 seconds, so the object hibernates and wakes for each. */
async function sparsePhases(state: State): Promise<void> {
  const a = state.artifacts;
  let sparse: string[] = [];
  await phase(state, "page create x12, 15 s apart (cold)", 12, async () => {
    const out = await paced(
      state,
      { kind: "page_create", artifact: a.bench, authors: 1 },
      12,
      15_000,
    );
    sparse = out.ids;
    return out;
  });
  await phase(state, "page get x12, 15 s apart (cold)", 12, () =>
    paced(state, { kind: "page_get", artifact: a.bench, authors: 1, ids: sparse }, 12, 15_000),
  );
}

/** Live: Team's 25 connections on one artifact's shared board, 40 writes 3 seconds apart. */
async function liveFanOut(state: State): Promise<void> {
  const a = state.artifacts;
  await phase(state, "live fan-out: 25 connections, 40 writes", 40, async () => {
    const sockets: Socket[] = [];
    for (let author = 0; author < 25; author++) {
      sockets.push(await openSocket(state, a.live as string, 1_000 + author, "team"));
    }
    let writes = 0;
    const renewals = await holdOpen(state, a.live as string, "team", sockets, 150_000, async () => {
      for (let index = 0; index < 40; index++) {
        await step(state, {
          kind: "board_create",
          artifact: a.live,
          plan: "team",
          authorBase: 2_000,
        });
        writes += 1;
        await sleep(3_000);
      }
    });
    return {
      writes,
      renewals,
      received: sockets.reduce((n, entry) => n + entry.received, 0),
      closes: sockets.map((entry) => entry.closed),
    };
  });
}

/** One socket sending 200 messages 50 ms apart, past the 4 a minute allowed in. */
async function hostileInbound(state: State, artifact: string): Promise<void> {
  await phase(state, "hostile live: 200 messages in from one socket", 200, async () => {
    const entry = await openSocket(state, artifact, 4_000, "free", true);
    let sent = 0;
    for (let index = 0; index < 200 && entry.closed === null; index++) {
      entry.socket.send(JSON.stringify({ subscribe: "notes" }));
      sent += 1;
      await sleep(50);
    }
    await sleep(2_000);
    entry.socket.close();
    return { sent, closed: entry.closed, received: entry.received };
  });
}

/** The phases a first run got wrong (see decision 0026, "Delivery 8 measurements"), alone. */
async function fixesWorkload(state: State): Promise<void> {
  for (const key of ["bench", "live"])
    await step(state, { kind: "declare", artifact: state.artifacts[key] });
  await sparsePhases(state);
  await liveFanOut(state);
  // A fresh artifact, so the Free plan's live message day is unspent when it connects.
  await step(state, { kind: "declare", artifact: state.artifacts.reads });
  await hostileInbound(state, state.artifacts.reads as string);
}

async function workload(state: State, alarms: boolean): Promise<void> {
  const a = state.artifacts;
  // Setup: every artifact's two collections (its first declaration creates its schema).
  for (const key of ["bench", "owner", "alarm", "live", "growth", "reads"]) {
    await step(state, { kind: "declare", artifact: a[key] });
  }
  const fan = Array.from({ length: 50 }, (_, index) => a[`fan${index}`] as string);
  await phase(state, "first declaration, 50 new objects", 50, () =>
    call(state, "/steps", {
      steps: fan.map((artifact) => ({ kind: "declare", artifact, plan: "team" })),
    }),
  );

  // The alarm phase: 120 visitor writes stamped as if made over one hour ending about 24 hours
  // ago, so their operation records and rate rows reach their retention within the run, all
  // before the next whole hour; the quiet tail then counts the alarms that prune them.
  const target = Math.ceil((Date.now() + 75 * 60_000) / HOUR) * HOUR;
  state.alarmAt = new Date(target).toISOString();
  await phase(state, "alarm workload (backdated writes)", 120, async () => {
    const out = [];
    for (let index = 0; index < 120; index++) {
      // Retention ends `replayMs` (a day) after the stamp: between target-62 and target-2 min.
      const stamp = target - 2 * 60_000 - (119 - index) * 30_000 - DAY;
      out.push(
        await step(state, {
          kind: "page_create",
          artifact: a.alarm,
          authors: 10,
          authorBase: 500 + (index % 10),
          backdateMs: Date.now() - stamp,
        }),
      );
    }
    return {
      ok: out.reduce((n, one) => n + one.ok, 0),
      refused: Object.assign({}, ...out.map((one) => one.refused)),
    };
  });

  // Unit costs, warm bursts on a Free artifact (roomy daily counters).
  const created = await (async () => {
    let ids: string[] = [];
    await phase(state, "page create x100 (warm)", 100, async () => {
      const out = await step(state, {
        kind: "page_create",
        artifact: a.bench,
        count: 100,
        authors: 10,
      });
      ids = out.ids;
      return out;
    });
    return ids;
  })();
  await phase(state, "page replace x100 (warm)", 100, () =>
    step(state, { kind: "page_replace", artifact: a.bench, count: 100, authors: 10, ids: created }),
  );
  await phase(state, "page get x100 (warm)", 100, () =>
    step(state, { kind: "page_get", artifact: a.bench, count: 100, authors: 10, ids: created }),
  );
  await phase(state, "page query of 20 x100 (warm)", 100, () =>
    step(state, { kind: "page_query", artifact: a.bench, count: 100, authors: 10 }),
  );
  await phase(state, "page remove x50 (warm)", 50, () =>
    step(state, { kind: "page_remove", artifact: a.bench, count: 50, authors: 10, ids: created }),
  );
  await phase(state, "shared board create x50 (warm)", 50, () =>
    step(state, { kind: "board_create", artifact: a.bench, count: 50, authors: 10 }),
  );

  await sparsePhases(state);

  // The owner side on a Team artifact.
  await phase(state, "owner create x50", 50, () =>
    step(state, { kind: "owner_create", artifact: a.owner, plan: "team", count: 50 }),
  );
  let bulk: string[] = [];
  await phase(state, "owner bulk create of 100 x10", 10, async () => {
    const out = await step(state, {
      kind: "owner_bulk_create",
      artifact: a.owner,
      plan: "team",
      count: 10,
      bulk: 100,
    });
    bulk = out.ids;
    return out;
  });
  await phase(state, "owner query of 100 x50", 50, () =>
    step(state, { kind: "owner_query", artifact: a.owner, plan: "team", count: 50 }),
  );
  await phase(state, "owner count x50", 50, () =>
    step(state, { kind: "owner_count", artifact: a.owner, plan: "team", count: 50 }),
  );
  await phase(state, "owner export of 1,050 documents", 3, () =>
    step(state, { kind: "owner_export", artifact: a.owner, plan: "team" }),
  );
  await phase(state, "owner bulk remove of 100 x10", 10, () =>
    step(state, {
      kind: "owner_bulk_remove",
      artifact: a.owner,
      plan: "team",
      count: 10,
      bulk: 100,
      ids: bulk,
    }),
  );

  // Team's 50 data artifacts in use at once: 5 visitor writes each, in parallel.
  await phase(state, "50 artifacts x5 writes (parallel)", 250, () =>
    call(state, "/steps", {
      steps: fan.map((artifact) => ({
        kind: "page_create",
        artifact,
        plan: "team",
        count: 5,
        authors: 5,
      })),
    }),
  );

  await liveFanOut(state);
  await phase(state, "live idle: 10 connections, 5 minutes", 0, async () => {
    const sockets: Socket[] = [];
    for (let author = 0; author < 10; author++) {
      sockets.push(await openSocket(state, a.live as string, 3_000 + author, "team"));
    }
    const renewals = await holdOpen(state, a.live as string, "team", sockets, 5 * 60_000);
    return { renewals, received: sockets.reduce((n, entry) => n + entry.received, 0) };
  });
  await hostileInbound(state, a.live as string);
  await phase(state, "hostile live: connects past the limits", 40, async () => {
    // One author, 40 connects in a burst on a Free artifact (limits: 4 per author, 6 a minute).
    const outcomes: Record<string, number> = {};
    const open: Socket[] = [];
    for (let index = 0; index < 40; index++) {
      try {
        const entry = await openSocket(state, a.growth as string, 5_000, "free", true);
        const key = entry.closed === null ? "open" : `closed ${entry.closed}`;
        outcomes[key] = (outcomes[key] ?? 0) + 1;
        open.push(entry);
      } catch {
        outcomes.refused = (outcomes.refused ?? 0) + 1;
      }
    }
    for (const entry of open) entry.socket.close();
    return outcomes;
  });

  // Hostile growth on a Free artifact with its real limits: 300 writers (the anonymous writers'
  // shape: many authors, each under its own rate) spend the day, then keep trying.
  await phase(state, "hostile growth: 300 writers until the day is spent", 700, () =>
    step(state, {
      kind: "page_create",
      artifact: a.growth,
      real: true,
      count: 700,
      authors: 300,
      authorBase: 10_000,
      bytes: 1_000,
    }),
  );
  await phase(state, "hostile growth: 500 writes refused (day spent)", 500, () =>
    step(state, {
      kind: "page_create",
      artifact: a.growth,
      real: true,
      count: 500,
      authors: 300,
      authorBase: 10_000,
    }),
  );
  await phase(state, "hostile refusals: oversize and no-write x50 each", 100, async () => ({
    oversize: await step(state, {
      kind: "oversize",
      artifact: a.growth,
      real: true,
      count: 50,
      authors: 50,
    }),
    noWrite: await step(state, {
      kind: "no_grant_write",
      artifact: a.growth,
      real: true,
      count: 50,
      authors: 50,
    }),
  }));
  // Hostile reads on a Free artifact with its real limits: one caller past its minute, then many.
  await step(state, { kind: "page_create", artifact: a.reads, count: 30, authors: 3 });
  await phase(state, "hostile reads: one caller, 1,000 queries", 1_000, () =>
    step(state, {
      kind: "page_query",
      artifact: a.reads,
      real: true,
      count: 1_000,
      authors: 1,
      authorBase: 20_000,
    }),
  );
  await phase(state, "hostile reads: 100 callers, 3,000 queries", 3_000, () =>
    step(state, {
      kind: "page_query",
      artifact: a.reads,
      real: true,
      count: 3_000,
      authors: 100,
      authorBase: 30_000,
    }),
  );

  if (alarms) {
    // The quiet tail: nothing runs until 15 minutes after the alarm phase's hour.
    const quietFrom = nextPhaseStart(Date.now());
    const until = Date.parse(state.alarmAt) + 15 * 60_000;
    log(`quiet until ${new Date(until).toISOString()} for the pruning alarms`);
    await sleep(Math.max(0, quietFrom - Date.now()));
    await sleep(Math.max(0, until - Date.now()));
    state.windows.push({
      phase: "quiet tail (pruning alarms)",
      start: new Date(quietFrom).toISOString(),
      end: new Date(floorMinute(until)).toISOString(),
      commands: 0,
    });
    state.results.alarmControl = await call(state, "/control", { artifact: a.alarm });
    save(state);
  }
}

/**
 * One GraphQL request. Wrangler's login token lives about an hour, so an authentication error
 * fetches a fresh one once; a rate limit waits a minute and tries again, up to five times, since
 * the per-field fallback would otherwise spend the account's API allowance (run of 2026-11-16).
 */
async function graphql(
  state: State,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data?: unknown; errors?: { message: string }[] }> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(GRAPHQL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken(state)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { accountTag: state.accountId, ...variables } }),
    });
    const body = (await response.json()) as { data?: unknown; errors?: { message: string }[] };
    const message = body.errors?.[0]?.message ?? "";
    if (attempt < 5 && /authentication/i.test(message) && !process.env.CLOUDFLARE_API_TOKEN) {
      cachedToken = undefined;
      continue;
    }
    if (attempt < 5 && (response.status === 429 || /rate limit|throttl/i.test(message))) {
      await sleep(60_000);
      continue;
    }
    // Spread requests out: the account allows a few hundred GraphQL requests per five minutes.
    await sleep(500);
    return body;
  }
}

function rowsOf(answer: { data?: unknown }): { sum?: Record<string, number> }[] {
  const data = answer.data as { viewer?: { accounts?: { rows?: unknown[] }[] } } | undefined;
  return (data?.viewer?.accounts?.[0]?.rows ?? []) as { sum?: Record<string, number> }[];
}

async function measure(state: State, dataset: Dataset, window: Window, missing: Set<string>) {
  const range = windowFor(dataset, window);
  const all = await graphql(state, datasetQuery(dataset), range);
  if (!all.errors?.length) return totals(rowsOf(all), dataset.aggregate);
  const out: Record<string, number> = {};
  for (const field of dataset.fields) {
    const one = await graphql(state, datasetQuery(dataset, [field]), range);
    if (one.errors?.length) {
      missing.add(`${dataset.name}.${field}: ${one.errors[0]?.message.slice(0, 120)}`);
      continue;
    }
    Object.assign(out, totals(rowsOf(one), dataset.aggregate));
  }
  return out;
}

/** The jobs Worker's collector queries, read from its source, run against this run's namespace. */
async function collectorCheck(state: State): Promise<Record<string, unknown>> {
  const source = readFileSync(
    join(here, "..", "..", "..", "apps", "jobs", "src", "analytics.ts"),
    "utf8",
  );
  const query = (name: string) =>
    new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;`).exec(source)?.[1] ?? "";
  const first = state.windows[0];
  const last = state.windows.at(-1);
  const range = { start: first?.start, end: last?.end };
  const out: Record<string, unknown> = {};
  out.requests = await graphql(state, query("DATA_REQUESTS_QUERY"), {
    ...range,
    dataScripts: [state.worker],
  });
  out.usage = await graphql(state, query("DATA_USAGE_QUERY"), {
    ...range,
    namespaceIds: [state.namespaceId],
  });
  out.storage = await graphql(state, query("DATA_STORAGE_QUERY"), {
    ...range,
    namespaceIds: [state.namespaceId],
  });
  // The storage dataset's documented filter on this account's schema (`namespaceIds_hasany`).
  out.storageHasAny = await graphql(
    state,
    `query S($accountTag: string!, $start: Time!, $end: Time!, $namespaceIds: [string!]!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    durableObjectsStorageGroups(limit: 1000, filter: { datetime_geq: $start, datetime_lt: $end, namespaceIds_hasany: $namespaceIds }, orderBy: [datetime_DESC]) {
      max { storedBytes } dimensions { datetime namespaceIds }
    } } } }`,
    { start: range.start, end: new Date().toISOString(), namespaceIds: [state.namespaceId] },
  );
  return out;
}

async function report(state: State): Promise<void> {
  state.namespaceId ??= await namespaceOf(state);
  const sets = datasets(
    { worker: state.worker, database: "", bucket: "" },
    state.namespaceId ?? null,
  );
  const missing = new Set<string>();
  const raw: Record<string, unknown> = {};
  const rows: (string | number | null)[][] = [];
  for (const window of state.windows) {
    const figures: Record<string, Record<string, number>> = {};
    for (const set of sets) figures[set.key] = await measure(state, set, window, missing);
    raw[window.phase] = figures;
    const inv = figures.invocations ?? {};
    const per = figures.periodic ?? {};
    const n = Math.max(window.commands, 1);
    rows.push([
      window.phase,
      window.commands,
      inv.requests ?? null,
      round((per.activeTime ?? 0) / 1000 / n),
      round((inv.wallTime ?? 0) / 1000 / Math.max(inv.requests ?? 1, 1)),
      round(((per.activeTime ?? 0) / 1_000_000) * 0.128, 4),
      round((per.cpuTime ?? 0) / 1000 / n),
      round((per.rowsRead ?? 0) / n, 1),
      round((per.rowsWritten ?? 0) / n, 1),
      per.inboundWebsocketMsgCount ?? 0,
      per.outboundWebsocketMsgCount ?? 0,
    ]);
  }
  log(
    table(
      [
        "Phase",
        "Commands",
        "DO requests",
        "Active ms/command",
        "Wall ms/request",
        "GB-s",
        "CPU ms/command",
        "Rows read/command",
        "Rows written/command",
        "WS in",
        "WS out",
      ],
      rows,
    ),
  );
  if (missing.size > 0) log(`fields refused:\n  ${[...missing].join("\n  ")}`);
  raw.collector = await collectorCheck(state);
  writeFileSync(join(state.dir, "analytics.json"), JSON.stringify(raw, null, 2), { mode: 0o600 });
  log(
    `raw analytics and results: ${join(state.dir, "analytics.json")}, ${join(state.dir, "state.json")}`,
  );
}

async function cleanup(state: State): Promise<void> {
  if (!state.created) {
    log("nothing to delete");
    return;
  }
  const entry = join(state.dir, "deleted.js");
  writeFileSync(entry, DELETION_ENTRY);
  const config = join(state.dir, "wrangler.deletion.json");
  writeFileSync(
    config,
    JSON.stringify(
      deletionConfig({ worker: state.worker, database: "", bucket: "" }, entry),
      null,
      2,
    ),
  );
  const migrated = wrangler(state, ["deploy", "--config", config]);
  log(
    `delete every object (deleted_classes): ${migrated.ok ? "done" : alreadyGone(migrated.output) ? "already gone" : "FAILED"}`,
  );
  const removed = wrangler(state, ["delete", "--name", guardName(state.worker), "--force"]);
  const gone = removed.ok || alreadyGone(removed.output);
  log(`delete Worker ${state.worker}: ${removed.ok ? "done" : gone ? "already gone" : "FAILED"}`);
  if (gone) state.created = false;
  save(state);
}

async function main(): Promise<void> {
  const { command, options } = args(process.argv.slice(2));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error("set CLOUDFLARE_ACCOUNT_ID");
  if (command === "run") {
    const run = runSuffix(options.run ?? randomBytes(4).toString("hex"));
    const dir = join(tmpdir(), `pf-exp-measure-${run}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const artifacts: Record<string, string> = {};
    for (const key of ["bench", "owner", "alarm", "live", "growth", "reads"])
      artifacts[key] = artifactId();
    for (let index = 0; index < 50; index++) artifacts[`fan${index}`] = artifactId();
    const state: State = {
      run,
      accountId,
      worker: guardName(`pf-exp-data-${run}`),
      dir,
      token: randomBytes(32).toString("base64url"),
      artifacts,
      windows: [],
      results: {},
      created: false,
    };
    save(state);
    log(`state: ${join(dir, "state.json")}`);
    try {
      await deploy(state);
      state.namespaceId = await namespaceOf(state);
      save(state);
      if (options.only === "fixes") await fixesWorkload(state);
      else await workload(state, options["skip-alarms"] !== "true");
      // Analytics arrive within about a minute (delivery 2); wait three to be safe.
      await sleep(3 * 60_000);
      await report(state);
    } finally {
      await cleanup(state);
    }
    return;
  }
  const file = options.state;
  if (!file) throw new Error("--state <file> is required");
  const state = load(file);
  if (command === "report") await report(state);
  else if (command === "cleanup") await cleanup(state);
  else throw new Error(`unknown command ${command}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
