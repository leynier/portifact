// Runbook for decision 0026's feasibility experiments 2 and 3 on a scratch deployment. Run by the
// maintainer's agent with the deploy credentials, never by CI. It creates only resources named
// `pf-exp-…` (a Worker with the spike's object, a D1 database, an R2 bucket), runs the restore
// drill with a real D1 Time Travel restore and the billing workload, reads Cloudflare's GraphQL
// analytics, prints observed against expected, and deletes everything it created.
//
//   CLOUDFLARE_API_TOKEN=… node spikes/artifact-data/drill/runbook.ts run --account-id <id>
//   CLOUDFLARE_API_TOKEN=… node spikes/artifact-data/drill/runbook.ts report --state <file>
//   CLOUDFLARE_API_TOKEN=… node spikes/artifact-data/drill/runbook.ts cleanup --state <file>
//
// Options of `run`: --run <suffix> (default: random), --commands <n> per kind (50),
// --idle-minutes <n> (10), --analytics-wait-minutes <n> (30), --skip-drill, --skip-workload.
// The token is read from the environment only and never printed. State (resource names, the
// scratch Worker's URL and its random access token, phase windows) is kept in a 0600 file under
// the system's temporary directory, so `report` can resume and `cleanup` can always run again.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSUMED,
  alreadyGone,
  type Dataset,
  DELETION_ENTRY,
  datasetQuery,
  datasets,
  deletionConfig,
  guardName,
  type Names,
  nextPhaseStart,
  type PhaseReport,
  phaseEnd,
  phaseReport,
  RECORD_ROWS,
  resourceNames,
  round,
  runSuffix,
  table,
  totals,
  windowFor,
  workerConfig,
  workersDevUrl,
} from "../src/runbook-plan.ts";

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const KINDS = ["create", "replace", "get", "page", "ownerCreate", "count", "export", "delete"];

interface Window {
  phase: string;
  start: string;
  end: string;
  commands: number;
}

interface State {
  run: string;
  accountId: string;
  names: Names;
  dir: string;
  databaseId?: string;
  url?: string | undefined;
  drillToken: string;
  namespaceId?: string | undefined;
  windows: Window[];
  workloadEnd?: string;
  drill?: unknown;
  created: { database: boolean; bucket: boolean; worker: boolean };
}

const here = fileURLToPath(new URL(".", import.meta.url));
const wranglerBin = join(here, "..", "node_modules", ".bin", "wrangler");

function args(argv: string[]): { command: string; options: Record<string, string> } {
  const [command = "help", ...rest] = argv;
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index] ?? "";
    if (!key.startsWith("--")) throw new Error(`unexpected argument ${key}`);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) options[key.slice(2)] = "true";
    else {
      options[key.slice(2)] = next;
      index += 1;
    }
  }
  return { command, options };
}

function token(): string {
  const value = process.env.CLOUDFLARE_API_TOKEN;
  if (!value) throw new Error("set CLOUDFLARE_API_TOKEN in the environment (it is never printed)");
  return value;
}

function save(state: State): void {
  const file = join(state.dir, "state.json");
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

function load(file: string): State {
  const state = JSON.parse(readFileSync(file, "utf8")) as State;
  // A state file names the resources to delete: check them as if they were arguments.
  const expected = resourceNames(state.run);
  for (const key of ["worker", "database", "bucket"] as const) {
    if (guardName(state.names[key]) !== expected[key]) throw new Error("state file names differ");
  }
  return state;
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Runs wrangler with the account in its environment; output is returned, never the token. */
function wrangler(state: State, argv: string[], input?: string): { ok: boolean; output: string } {
  const result = spawnSync(wranglerBin, argv, {
    cwd: state.dir,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: state.accountId, CI: "true" },
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, output };
}

function must(result: { ok: boolean; output: string }, what: string): string {
  if (!result.ok) throw new Error(`${what} failed:\n${result.output.slice(-2000)}`);
  return result.output;
}

async function call<T>(state: State, path: string, body: unknown): Promise<T> {
  if (!state.url) throw new Error("the scratch Worker has no URL yet");
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${state.url}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.drillToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return (await response.json()) as T;
    // A fresh workers.dev route can answer 404 for a few seconds after the first deploy.
    if (attempt < 10 && (response.status === 404 || response.status >= 500)) {
      await sleep(3_000);
      continue;
    }
    throw new Error(
      `${path} answered ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deploy(state: State): Promise<void> {
  const names = state.names;
  if (!state.created.database) {
    must(wrangler(state, ["d1", "create", guardName(names.database)]), "creating the database");
    state.created.database = true;
    save(state);
  }
  const info = JSON.parse(
    must(
      wrangler(state, ["d1", "info", guardName(names.database), "--json"]),
      "reading the database",
    ),
  ) as { uuid?: string };
  if (!info.uuid) throw new Error("wrangler d1 info returned no uuid");
  state.databaseId = info.uuid;
  if (!state.created.bucket) {
    must(
      wrangler(state, ["r2", "bucket", "create", guardName(names.bucket)]),
      "creating the bucket",
    );
    state.created.bucket = true;
    save(state);
  }
  const config = join(state.dir, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify(workerConfig(names, join(here, "worker.ts"), state.databaseId), null, 2),
  );
  state.created.worker = true;
  save(state);
  const output = must(wrangler(state, ["deploy", "--config", config]), "deploying the Worker");
  state.url = workersDevUrl(output) ?? undefined;
  if (!state.url)
    throw new Error("deploy printed no workers.dev URL (is a workers.dev subdomain set up?)");
  must(
    wrangler(state, ["secret", "put", "DRILL_TOKEN", "--config", config], state.drillToken),
    "setting the access token",
  );
  state.namespaceId = await namespaceOf(state);
  save(state);
  await call(state, "/setup", {});
  log(`deployed ${names.worker} with ${names.database} and ${names.bucket}`);
}

async function namespaceOf(state: State): Promise<string | undefined> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${state.accountId}/workers/durable_objects/namespaces?per_page=1000`,
    { headers: { Authorization: `Bearer ${token()}` } },
  );
  const body = (await response.json()) as {
    result?: { id: string; script?: string; class?: string }[];
  };
  return body.result?.find(
    (namespace) =>
      namespace.script === state.names.worker && namespace.class === "ArtifactDocuments",
  )?.id;
}

// Experiment 2: the restore drill with a real Time Travel restore.

interface DrillResult {
  name: string;
  transition: string;
  action: string;
  expectedAction: string;
  probe: Record<string, unknown>;
  expected: Record<string, unknown>;
  pass: boolean;
}

async function restoreDrill(state: State): Promise<void> {
  const run = state.run;
  log("restore drill: transitions before the restore point");
  let { states } = await call<{ states: unknown[] }>(state, "/drill/before", { run, states: [] });
  await sleep(5_000);
  const info = JSON.parse(
    must(
      wrangler(state, ["d1", "time-travel", "info", guardName(state.names.database), "--json"]),
      "reading the Time Travel bookmark",
    ),
  ) as { bookmark?: string };
  if (!info.bookmark) throw new Error("time-travel info returned no bookmark");
  await sleep(5_000);
  log("restore drill: transitions after the restore point");
  ({ states } = await call<{ states: unknown[] }>(state, "/drill/after", { run, states }));
  const file = await call<unknown>(state, "/drill/export", { run });
  ({ states } = await call<{ states: unknown[] }>(state, "/drill/after-export", { run, states }));
  log("restore drill: restoring the database to the bookmark");
  must(
    wrangler(state, [
      "d1",
      "time-travel",
      "restore",
      guardName(state.names.database),
      "--bookmark",
      info.bookmark,
    ]),
    "restoring",
  );
  const { windowWrite } = await call<{ windowWrite: string }>(state, "/drill/window", { run });
  await call(state, "/drill/apply", { run, file });
  const { actions } = await call<{ actions: Record<string, string> }>(state, "/drill/reconcile", {
    run,
  });
  const { results } = await call<{ results: DrillResult[] }>(state, "/drill/probe", {
    run,
    actions,
  });
  const followUps = await call<{
    observed: Record<string, unknown>;
    expected: Record<string, unknown>;
  }>(state, "/drill/follow-ups", { run });
  state.drill = { windowWrite, results, followUps };
  save(state);
  const short = (probe: Record<string, unknown>) =>
    `${probe.ownerRead}/${probe.ownerWrite}/${probe.visitorWrite}/${probe.operatorExport}/${probe.documents}/${probe.quarantined}`;
  log(
    table(
      [
        "Scenario",
        "Action",
        "Expected",
        "Owner r/w, visitor w, operator, docs, quarantined",
        "Expected",
        "Pass",
      ],
      results.map((r) => [
        r.name,
        r.action,
        r.expectedAction,
        short(r.probe),
        short(r.expected),
        r.pass ? "yes" : "NO",
      ]),
    ),
  );
  log(
    table(
      ["Follow-up", "Observed", "Expected"],
      Object.keys(followUps.expected).map((key) => [
        key,
        String(followUps.observed[key]),
        String(followUps.expected[key]),
      ]),
    ),
  );
  log(
    `write by a revoked grant between the restore and apply-tombstones: ${windowWrite} (expected ok)`,
  );
}

// Experiment 3: the billing workload.

async function phase(
  state: State,
  name: string,
  commands: number,
  work: () => Promise<void>,
): Promise<void> {
  // A whole minute without work before every phase, and the phase's window starts on its
  // minute (nextPhaseStart, phaseEnd), so no per-minute group holds two phases.
  await sleep(Math.max(0, nextPhaseStart(Date.now()) - Date.now()));
  const start = new Date();
  await work();
  const end = new Date(phaseEnd(Date.now()));
  state.windows.push({ phase: name, start: start.toISOString(), end: end.toISOString(), commands });
  save(state);
  log(`phase ${name}: ${commands} command(s), ${start.toISOString()} to ${end.toISOString()}`);
}

async function workload(state: State, perKind: number, idleMinutes: number): Promise<void> {
  const bench = `pfxbench${state.run}`;
  const held = `pfxheld${state.run}`;
  await call(state, "/bench/prepare", { artifact: bench });
  await call(state, "/bench/prepare", { artifact: held });
  let ids: string[] = [];
  for (const kind of KINDS) {
    await phase(state, kind, perKind, async () => {
      const next: string[] = [];
      for (let index = 0; index < perKind; index++) {
        const id = ids[index];
        const answer = await call<{ ok: boolean; id?: string; error?: string }>(
          state,
          "/bench/command",
          { artifact: bench, kind, id },
        );
        if (!answer.ok) throw new Error(`${kind} refused: ${answer.error}`);
        if (kind === "create" && answer.id) next.push(answer.id);
      }
      if (kind === "create") ids = next;
    });
  }
  const idle = idleMinutes * 60_000;
  await phase(state, "idle object", 0, () => sleep(idle));
  await call(state, "/bench/hold", { artifact: held });
  await phase(state, "held object", 0, () => sleep(idle));
  await phase(state, "idle live connection", 0, async () => {
    const socket = await openSocket(state, bench, idle + 60_000);
    await sleep(idle);
    socket.close();
  });
  let received = 0;
  const writes = Math.floor(idle / 15_000);
  await phase(state, "live connection with messages", writes, async () => {
    const socket = await openSocket(state, bench, idle + 60_000);
    socket.addEventListener("message", () => {
      received += 1;
    });
    for (let index = 0; index < writes; index++) {
      await call(state, "/bench/command", { artifact: bench, kind: "create" });
      await sleep(15_000);
    }
    socket.close();
  });
  state.workloadEnd = new Date().toISOString();
  save(state);
  log(`live messages received: ${received} for ${writes} writes`);
}

async function openSocket(state: State, artifact: string, deadlineMs: number): Promise<WebSocket> {
  const url = new URL(`${state.url?.replace("https://", "wss://")}/live`);
  url.searchParams.set("artifact", artifact);
  url.searchParams.set("deadlineMs", String(deadlineMs));
  url.searchParams.set("token", state.drillToken);
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("the live connection failed")), {
      once: true,
    });
  });
  socket.send(JSON.stringify({ subscribe: "notes" }));
  return socket;
}

async function graphql(
  state: State,
  query: string,
  window: Window,
): Promise<{ data?: unknown; errors?: { message: string }[] }> {
  const response = await fetch(GRAPHQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { accountTag: state.accountId, start: window.start, end: window.end },
    }),
  });
  return (await response.json()) as { data?: unknown; errors?: { message: string }[] };
}

function rowsOf(answer: { data?: unknown }): { sum?: Record<string, number> }[] {
  const data = answer.data as { viewer?: { accounts?: { rows?: unknown[] }[] } } | undefined;
  return (data?.viewer?.accounts?.[0]?.rows ?? []) as { sum?: Record<string, number> }[];
}

/** One dataset over one window; fields the schema refuses are dropped one at a time. */
async function measure(
  state: State,
  dataset: Dataset,
  phase: Window,
  missing: Set<string>,
): Promise<Record<string, number>> {
  const window = { ...phase, ...windowFor(dataset, phase) };
  const all = await graphql(state, datasetQuery(dataset), window);
  if (!all.errors?.length) return totals(rowsOf(all), dataset.aggregate);
  const out: Record<string, number> = {};
  for (const field of dataset.fields) {
    const one = await graphql(state, datasetQuery(dataset, [field]), window);
    if (one.errors?.length) {
      missing.add(`${dataset.name}.${field}: ${one.errors[0]?.message.slice(0, 120)}`);
      continue;
    }
    Object.assign(out, totals(rowsOf(one), dataset.aggregate));
  }
  return out;
}

async function report(state: State, waitMinutes: number): Promise<boolean> {
  if (state.windows.length === 0) {
    log("no workload windows recorded: nothing to report");
    return true;
  }
  state.namespaceId ??= await namespaceOf(state);
  const sets = datasets(state.names, state.namespaceId ?? null);
  const invocations = sets.find((set) => set.key === "invocations") as Dataset;
  const last = state.windows.find((window) => window.commands > 0 && window.phase === "delete");
  const deadline = Date.now() + waitMinutes * 60_000;
  const ended = Date.parse(state.workloadEnd ?? new Date().toISOString());
  // Analytics arrive minutes after the work: wait until the last command phase is counted.
  for (;;) {
    const missing = new Set<string>();
    const counted = last ? ((await measure(state, invocations, last, missing)).requests ?? 0) : 0;
    if (last === undefined || counted >= last.commands) {
      log(
        `analytics complete ${((Date.now() - ended) / 60_000).toFixed(1)} minute(s) after the workload`,
      );
      break;
    }
    if (Date.now() > deadline) {
      log(
        `analytics still incomplete (${counted} of ${last.commands} requests); resume with:\n  node spikes/artifact-data/drill/runbook.ts report --state ${join(state.dir, "state.json")}`,
      );
      return false;
    }
    await sleep(60_000);
  }
  const missing = new Set<string>();
  const reports: PhaseReport[] = [];
  const raw: Record<string, unknown> = {};
  for (const window of state.windows) {
    const figures: Record<string, Record<string, number>> = {};
    for (const set of sets) figures[set.key] = await measure(state, set, window, missing);
    raw[window.phase] = figures;
    reports.push(
      phaseReport(
        window.phase,
        Math.max(window.commands, 1),
        figures.invocations ?? {},
        figures.periodic ?? {},
      ),
    );
  }
  log(
    table(
      [
        "Phase",
        "Commands",
        "DO requests",
        "Active ms/command",
        `Assumed ${ASSUMED.activeMsLow} / ${ASSUMED.activeMsHigh}`,
        "Wall ms/request",
        "GB-s in window",
        "Rows read/command",
        "Rows written/command",
        "Record rows",
      ],
      reports.map((r) => [
        r.phase,
        r.commands,
        r.requests,
        round(r.activeMsPerCommand),
        `${ASSUMED.activeMsLow} / ${ASSUMED.activeMsHigh}`,
        round(r.wallMsPerRequest),
        round(r.gbSeconds, 4),
        round(r.rowsReadPerCommand, 1),
        round(r.rowsWrittenPerCommand, 1),
        RECORD_ROWS[r.phase]?.join(" / ") ?? "",
      ]),
    ),
  );
  if (missing.size > 0) log(`fields the analytics schema refused:\n  ${[...missing].join("\n  ")}`);
  writeFileSync(join(state.dir, "analytics.json"), JSON.stringify(raw, null, 2), { mode: 0o600 });
  log(`raw analytics: ${join(state.dir, "analytics.json")}`);
  return true;
}

async function cleanup(state: State): Promise<void> {
  const steps: [string, string][] = [];
  if (state.url) {
    try {
      const { removed } = await call<{ removed: number }>(state, "/clear", {});
      steps.push(["empty the bucket through the Worker", `${removed} object(s) removed`]);
    } catch (error) {
      steps.push(["empty the bucket through the Worker", `skipped: ${(error as Error).message}`]);
    }
  }
  if (state.created.worker) {
    const entry = join(state.dir, "deleted.js");
    writeFileSync(entry, DELETION_ENTRY);
    const config = join(state.dir, "wrangler.deletion.json");
    writeFileSync(config, JSON.stringify(deletionConfig(state.names, entry), null, 2));
    const migrated = wrangler(state, ["deploy", "--config", config]);
    steps.push([
      "delete every object (deleted_classes)",
      migrated.ok ? "done" : alreadyGone(migrated.output) ? "already gone" : "FAILED",
    ]);
    const removed = wrangler(state, ["delete", "--name", guardName(state.names.worker), "--force"]);
    steps.push([
      `delete Worker ${state.names.worker}`,
      removed.ok ? "done" : alreadyGone(removed.output) ? "already gone" : "FAILED",
    ]);
    if (removed.ok || alreadyGone(removed.output)) state.created.worker = false;
  }
  if (state.created.bucket) {
    const removed = wrangler(state, ["r2", "bucket", "delete", guardName(state.names.bucket)]);
    steps.push([
      `delete bucket ${state.names.bucket}`,
      removed.ok ? "done" : alreadyGone(removed.output) ? "already gone" : "FAILED",
    ]);
    if (removed.ok || alreadyGone(removed.output)) state.created.bucket = false;
  }
  if (state.created.database) {
    const removed = wrangler(state, [
      "d1",
      "delete",
      guardName(state.names.database),
      "--skip-confirmation",
    ]);
    steps.push([
      `delete database ${state.names.database}`,
      removed.ok ? "done" : alreadyGone(removed.output) ? "already gone" : "FAILED",
    ]);
    if (removed.ok || alreadyGone(removed.output)) state.created.database = false;
  }
  save(state);
  log(table(["Cleanup step", "Outcome"], steps));
  const left = Object.entries(state.created).filter(([, created]) => created);
  if (left.length > 0)
    log(`left behind: ${left.map(([kind]) => kind).join(", ")}; run cleanup again with --state`);
}

async function main(): Promise<void> {
  const { command, options } = args(process.argv.slice(2));
  token();
  if (!existsSync(wranglerBin)) throw new Error("wrangler is missing: run bun install first");
  if (command === "run") {
    const accountId = options["account-id"];
    if (!accountId || !/^[a-f0-9]{32}$/.test(accountId))
      throw new Error("--account-id <32 hex characters> is required");
    const run = runSuffix(options.run ?? randomBytes(4).toString("hex"));
    const dir = join(tmpdir(), `pf-exp-${run}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const state: State = {
      run,
      accountId,
      names: resourceNames(run),
      dir,
      drillToken: randomBytes(32).toString("base64url"),
      windows: [],
      created: { database: false, bucket: false, worker: false },
    };
    save(state);
    log(`state: ${join(dir, "state.json")}`);
    try {
      await deploy(state);
      if (options["skip-drill"] !== "true") await restoreDrill(state);
      if (options["skip-workload"] !== "true") {
        await workload(
          state,
          Number(options.commands ?? 50),
          Number(options["idle-minutes"] ?? 10),
        );
        await report(state, Number(options["analytics-wait-minutes"] ?? 30));
      }
    } finally {
      // Always, whatever failed: every resource the run created goes.
      await cleanup(state);
    }
    return;
  }
  const file = options.state;
  if (!file) throw new Error("--state <file> is required");
  const state = load(file);
  if (command === "report") await report(state, Number(options["analytics-wait-minutes"] ?? 30));
  else if (command === "cleanup") await cleanup(state);
  else throw new Error(`unknown command ${command}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
