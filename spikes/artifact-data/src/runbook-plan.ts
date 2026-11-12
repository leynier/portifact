// The pure half of the deployed runbook (drill/runbook.ts): resource names and the guard that
// keeps the script on `pf-exp-` resources, the scratch Worker's configuration, the GraphQL
// analytics queries and the arithmetic that turns their sums into the record's units. No I/O,
// so the workerd suite tests it; the runbook adds wrangler, fetch and the clock.

export const NAME_PREFIX = "pf-exp-";

/** Refuses any resource name that does not start with `pf-exp-`; every command goes through it. */
export function guardName(name: string): string {
  if (!name.startsWith(NAME_PREFIX) || !/^[a-z0-9-]{8,63}$/.test(name)) {
    throw new Error(`refusing to touch a resource not named ${NAME_PREFIX}…: ${name}`);
  }
  return name;
}

export interface Names {
  worker: string;
  database: string;
  bucket: string;
}

/** A run suffix: lowercase letters and digits, so every name stays valid for D1, R2 and Workers. */
export function runSuffix(value: string): string {
  if (!/^[a-z0-9]{4,20}$/.test(value)) throw new Error("the run suffix must be 4 to 20 of a-z0-9");
  return value;
}

export function resourceNames(run: string): Names {
  const suffix = runSuffix(run);
  return {
    worker: guardName(`${NAME_PREFIX}data-${suffix}`),
    database: guardName(`${NAME_PREFIX}data-${suffix}-db`),
    bucket: guardName(`${NAME_PREFIX}data-${suffix}-r2`),
  };
}

const COMPATIBILITY = { compatibility_date: "2026-08-01", compatibility_flags: ["nodejs_compat"] };

/** The scratch Worker's configuration: the spike's object, the drill's D1 and R2, workers.dev. */
export function workerConfig(names: Names, main: string, databaseId: string): object {
  return {
    name: guardName(names.worker),
    main,
    ...COMPATIBILITY,
    workers_dev: true,
    durable_objects: { bindings: [{ name: "DOCUMENTS", class_name: "ArtifactDocuments" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ArtifactDocuments"] }],
    d1_databases: [
      { binding: "MAIN", database_name: guardName(names.database), database_id: databaseId },
    ],
    r2_buckets: [{ binding: "JOURNAL", bucket_name: guardName(names.bucket) }],
  };
}

/**
 * The configuration that deletes every object of the class with its storage before the Worker
 * itself is deleted (a `deleted_classes` migration), with an entry that exports nothing.
 */
export function deletionConfig(names: Names, main: string): object {
  return {
    name: guardName(names.worker),
    main,
    ...COMPATIBILITY,
    workers_dev: false,
    migrations: [
      { tag: "v1", new_sqlite_classes: ["ArtifactDocuments"] },
      { tag: "v2", deleted_classes: ["ArtifactDocuments"] },
    ],
  };
}

export const DELETION_ENTRY =
  "export default { fetch: () => new Response(null, { status: 404 }) };\n";

/** Wrangler's answers that mean the resource is already gone: cleanup treats them as done. */
export function alreadyGone(output: string): boolean {
  return /not found|does not exist|couldn't find|could not find|no such|10007|10090|\b404\b/i.test(
    output,
  );
}

export function workersDevUrl(output: string): string | null {
  return /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0] ?? null;
}

// Analytics. The datasets are the ones Cloudflare documents for Workers and Durable Objects;
// field names that an account's schema lacks are dropped one by one, so the report says what
// it could not read instead of failing.

export interface Dataset {
  key: string;
  name: string;
  /** The filter object, with `$start` and `$end` as GraphQL variables. */
  filter: string;
  aggregate: "sum" | "max";
  fields: string[];
  /**
   * How the dataset's time filter matches: `instant` compares each event's time, `minute`
   * compares the start of its one-minute group (`datetimeMinute`), so a window must start on a
   * minute boundary or it drops the group its own first commands are in.
   */
  buckets: "instant" | "minute";
}

/**
 * The datasets the report reads. `cpuTime` is not a `sum` field of `workersInvocationsAdaptive`
 * (Cloudflare's Workers metrics tutorial queries it only as `quantiles { cpuTimeP50 cpuTimeP99 }`,
 * and the run of 2026-11-12 answered `unknown field "cpuTime"`), so it is not asked for. Stored
 * bytes are not read here: Cloudflare documents `durableObjectsStorageGroups` only with a date
 * filter and `max { storedBytes }`, no namespace filter (the run answered `unknown arg
 * namespaceId`), so its total would mix every project on the account; the object's own storage
 * report (`databaseSize`) and `cost.test.ts` measure bytes instead.
 */
export function datasets(names: Names, namespaceId: string | null): Dataset[] {
  const worker = JSON.stringify(names.worker);
  const list: Dataset[] = [
    {
      key: "worker",
      name: "workersInvocationsAdaptive",
      filter: `{ scriptName: ${worker}, datetime_geq: $start, datetime_lt: $end }`,
      aggregate: "sum",
      fields: ["requests", "errors", "subrequests", "duration", "wallTime"],
      buckets: "instant",
    },
    {
      key: "invocations",
      name: "durableObjectsInvocationsAdaptiveGroups",
      filter: `{ scriptName: ${worker}, datetime_geq: $start, datetime_lt: $end }`,
      aggregate: "sum",
      fields: ["requests", "errors", "wallTime", "responseBodySize"],
      buckets: "instant",
    },
  ];
  if (namespaceId !== null) {
    list.push({
      key: "periodic",
      name: "durableObjectsPeriodicGroups",
      filter: `{ namespaceId: ${JSON.stringify(namespaceId)}, datetimeMinute_geq: $start, datetimeMinute_lt: $end }`,
      aggregate: "sum",
      fields: [
        "activeTime",
        "cpuTime",
        "duration",
        "inboundWebsocketMsgCount",
        "outboundWebsocketMsgCount",
        "rowsRead",
        "rowsWritten",
        "storageReadUnits",
        "storageWriteUnits",
        "storageDeletes",
        "subrequests",
      ],
      buckets: "minute",
    });
  }
  return list;
}

const MINUTE = 60_000;

export function floorMinute(at: number): number {
  return Math.floor(at / MINUTE) * MINUTE;
}

export function ceilMinute(at: number): number {
  return Math.ceil(at / MINUTE) * MINUTE;
}

/**
 * The query window for one dataset: a per-minute dataset's start is floored to its minute, so
 * the group holding the phase's first commands is included; the end is the phase's own end,
 * already on a minute boundary.
 */
export function windowFor(
  dataset: Pick<Dataset, "buckets">,
  window: { start: string; end: string },
): { start: string; end: string } {
  if (dataset.buckets === "instant") return { start: window.start, end: window.end };
  return {
    start: new Date(floorMinute(Date.parse(window.start))).toISOString(),
    end: new Date(ceilMinute(Date.parse(window.end))).toISOString(),
  };
}

/**
 * When the next measured phase may start, given when the last work ended: the start of the
 * minute after the next one, so a whole minute with no work separates them. Durable Object
 * periodic groups were seen to carry a busy minute's work into an earlier group (the run of
 * 2026-11-12 reported no 18:16 group: the create phase landed in 18:15 with the deployment),
 * and the idle minute also lets the object hibernate between phases, so every phase starts cold
 * the same way.
 */
export function nextPhaseStart(lastWorkEnded: number): number {
  return floorMinute(lastWorkEnded) + 2 * MINUTE;
}

/** The end of a phase's window: the minute boundary after its last work. */
export function phaseEnd(lastWorkEnded: number): number {
  return floorMinute(lastWorkEnded) + MINUTE;
}

export function datasetQuery(dataset: Dataset, fields: string[] = dataset.fields): string {
  return `query PfExp($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      rows: ${dataset.name}(limit: 10000, filter: ${dataset.filter}) {
        ${dataset.aggregate} { ${fields.join(" ")} }
      }
    }
  }
}`;
}

/** Adds up the groups GraphQL returned for one dataset (max for storage). */
export function totals(
  rows: { sum?: Record<string, number>; max?: Record<string, number> }[],
  aggregate: "sum" | "max",
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    for (const [field, value] of Object.entries(row[aggregate] ?? {})) {
      if (typeof value !== "number") continue;
      out[field] =
        aggregate === "max" ? Math.max(out[field] ?? 0, value) : (out[field] ?? 0) + value;
    }
  }
  return out;
}

/** The record's assumptions (decision 0026, "Cost"). */
export const ASSUMED = { activeMsLow: 5, activeMsHigh: 100, gbPerObject: 0.128 } as const;

/** The record's rows per command (read, written), from "Measured rows per operation". */
export const RECORD_ROWS: Record<string, [number, number]> = {
  create: [11, 13],
  replace: [13, 9],
  get: [4, 0],
  page: [25, 0],
  delete: [12, 11],
  ownerCreate: [10, 14],
  count: [3, 0],
  export: [106, 2],
};

export interface PhaseReport {
  phase: string;
  commands: number;
  /** Durable Object requests the analytics counted in the phase's window. */
  requests: number | null;
  /** Active time per command in milliseconds, from `activeTime` (microseconds). */
  activeMsPerCommand: number | null;
  /** Wall time per request in milliseconds, from `wallTime` (microseconds). */
  wallMsPerRequest: number | null;
  /** Billed duration in GB-seconds over the window: active seconds times 0.128 GB. */
  gbSeconds: number | null;
  rowsReadPerCommand: number | null;
  rowsWrittenPerCommand: number | null;
}

const per = (value: number | undefined, count: number): number | null =>
  value === undefined || count === 0 ? null : value / count;

/** One phase's figures in the record's units. Microseconds are Cloudflare's documented unit. */
export function phaseReport(
  phase: string,
  commands: number,
  invocations: Record<string, number>,
  periodic: Record<string, number>,
): PhaseReport {
  const active = periodic.activeTime;
  return {
    phase,
    commands,
    requests: invocations.requests ?? null,
    activeMsPerCommand: per(active === undefined ? undefined : active / 1000, commands),
    wallMsPerRequest: per(
      invocations.wallTime === undefined ? undefined : invocations.wallTime / 1000,
      invocations.requests ?? 0,
    ),
    gbSeconds: active === undefined ? null : (active / 1_000_000) * ASSUMED.gbPerObject,
    rowsReadPerCommand: per(periodic.rowsRead, commands),
    rowsWrittenPerCommand: per(periodic.rowsWritten, commands),
  };
}

/** A plain text table, columns padded, for the runbook's output and the record. */
export function table(headers: string[], rows: (string | number | null)[][]): string {
  const cells = [
    headers,
    ...rows.map((row) => row.map((cell) => (cell === null ? "n/a" : String(cell)))),
  ];
  const widths = headers.map((_, column) =>
    Math.max(...cells.map((row) => (row[column] ?? "").length)),
  );
  return cells
    .map((row) => `| ${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`)
    .join("\n");
}

export function round(value: number | null, digits = 2): number | null {
  return value === null ? null : Number(value.toFixed(digits));
}
