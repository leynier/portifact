// The lifecycle harness (decision 0026, delivery 4, second half): the jobs Worker's services
// driving the real documents object, D1 and R2 in workerd. Objects are reached through the
// lifecycle RPC methods, exactly as the jobs Worker reaches them (`env.DOCUMENTS` stands for its
// `ARTIFACT_DOCUMENTS` binding: same class, same script); only seeding goes inside the object.
//
// The scheduler is the test's, as in the first half's driver: before any command, each object's
// `setAlarm` and `deleteAlarm` are replaced by a recorder (`quiet`), so no real alarm is ever set
// and nothing a test does depends on today's date or a year; `afterEach` checks that every object
// a test touched has no platform alarm. Commands carry the fixed `DATA_NOW`.
// `Crash` injects one failure at a numbered external step (a D1 write, an R2 write, a lifecycle
// command), before or after the step takes effect, for the crash schedules of obligation 9.

import { env, runInDurableObject } from "cloudflare:test";
import type { JobMessage } from "@portifact/contracts";
import {
  type DataEnvelope,
  type JournalEntry,
  OWNER_AUTHOR,
} from "@portifact/contracts/artifact-data";
import { aliasBinding, type RegionalDb, regionsFromEnv, schema } from "@portifact/db";
import { journalKey, LIFECYCLE_LIMITS, parseReviewed } from "@portifact/domain/artifact-data";
import {
  type DataObjectRpc,
  type DataObjects,
  lifecycleId,
  registerDataObject,
  runJob,
} from "@portifact/services";
import { eq } from "drizzle-orm";
import { afterEach, expect } from "vitest";
import type { ArtifactDocuments } from "../src/documents.ts";

/** The alarm each object asked for, recorded instead of set. */
export const recordedAlarms = new Map<string, number | null>();
const quieted = new Map<string, Promise<void>>();
const touched = new Set<string>();

/** Replaces the object's alarm calls by the recorder, once per object, before any command. */
export function quiet(id: string): Promise<void> {
  touched.add(id);
  let done = quieted.get(id);
  if (done === undefined) {
    done = runInDurableObject(
      env.DOCUMENTS.get(env.DOCUMENTS.idFromName(id)),
      async (_object: ArtifactDocuments, state: DurableObjectState) => {
        const storage = state.storage as unknown as Record<string, unknown>;
        storage.setAlarm = async (at: number | Date) => {
          recordedAlarms.set(id, typeof at === "number" ? at : at.getTime());
        };
        storage.deleteAlarm = async () => {
          recordedAlarms.set(id, null);
        };
      },
    );
    quieted.set(id, done);
  }
  return done;
}

afterEach(async () => {
  // No object a test touched may hold a platform alarm: the recorder replaced every set.
  for (const id of touched) {
    const alarm = await runInDurableObject(
      env.DOCUMENTS.get(env.DOCUMENTS.idFromName(id)),
      (_object: ArtifactDocuments, state: DurableObjectState) => state.storage.getAlarm(),
    );
    expect(alarm, `platform alarm on ${id}`).toBeNull();
  }
  touched.clear();
});

/** Every command an object receives runs at this fixed time; no platform alarm is ever set. */
export const DATA_NOW = Date.UTC(2026, 10, 9, 12);
export const D1_NOW = Date.UTC(2026, 10, 8, 12);
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function artifactId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) id += ALPHABET[byte % 32];
  return id;
}

export function visitorId(): string {
  return `v_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** A failure injected at one numbered external step. */
export class Crash {
  seen = 0;
  readonly steps: string[] = [];
  constructor(
    readonly at: number | null = null,
    readonly when: "before" | "after" = "before",
  ) {}

  /** Runs one external step, failing it at the chosen number. */
  async step<T>(label: string, run: () => Promise<T>): Promise<T> {
    this.seen += 1;
    this.steps.push(label);
    if (this.seen === this.at && this.when === "before") throw new InjectedCrash(label);
    const result = await run();
    if (this.seen === this.at && this.when === "after") throw new InjectedCrash(label);
    return result;
  }
}

export class InjectedCrash extends Error {
  constructor(readonly label: string) {
    super(`injected crash at ${label}`);
  }
}

const WRITE = /^\s*(insert|update|delete|replace|with)\b/i;

/** A D1 binding whose writes (single statements and batches) are crash steps. */
function crashingD1(d1: D1Database, crash: Crash): D1Database {
  const writes = new WeakSet<object>();
  const mark = (statement: D1PreparedStatement) => {
    writes.add(statement);
    const bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => {
      const bound = bind(...values);
      mark(bound);
      return bound;
    };
    for (const method of ["run", "all", "first", "raw"] as const) {
      const original = (statement[method] as (...args: unknown[]) => Promise<unknown>).bind(
        statement,
      );
      (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
        crash.step(`d1:${method}`, () => original(...args));
    }
  };
  return aliasBinding(
    new Proxy(d1, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            const statement = target.prepare(query);
            if (WRITE.test(query)) mark(statement);
            return statement;
          };
        }
        if (property === "batch") {
          return (statements: D1PreparedStatement[]) =>
            statements.some((statement) => writes.has(statement))
              ? crash.step("d1:batch", () => target.batch(statements))
              : target.batch(statements);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    d1,
  );
}

/** An R2 bucket whose writes (puts and deletes) are crash steps. */
function crashingBucket(bucket: R2Bucket, crash: Crash): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      if (property === "put" || property === "delete") {
        const original = (target[property] as (...args: unknown[]) => Promise<unknown>).bind(
          target,
        );
        return (...args: unknown[]) =>
          crash.step(`r2:${String(property)}`, () => original(...args));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const MUTATING = new Set([
  "lifecycleFence",
  "lifecycleErase",
  "lifecycleEraseAuthor",
  "lifecycleQuarantine",
  "lifecycleResolve",
]);

/** The objects of a region through the binding, their mutating commands crash steps. */
export function objectsFor(
  region: "default" | "eu" = "default",
  options: { crash?: Crash; createsObjects?: boolean } = {},
): DataObjects {
  return {
    region,
    createsObjects: options.createsObjects ?? false,
    object(id) {
      const stub = env.DOCUMENTS.get(env.DOCUMENTS.idFromName(id)) as unknown as DataObjectRpc;
      const crash = options.crash;
      const methods = stub as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      return new Proxy(stub, {
        get(target, property) {
          if (typeof property !== "string" || !property.startsWith("lifecycle")) {
            return Reflect.get(target, property);
          }
          // Called on the stub itself: an RPC stub's methods are not ordinary functions.
          const call = (...args: unknown[]) =>
            quiet(id).then(() => methods[property]?.(...args) as Promise<unknown>);
          if (crash === undefined || !MUTATING.has(property)) return call;
          return (...args: unknown[]) => crash.step(`object:${property}`, () => call(...args));
        },
      });
    },
  };
}

/** The handles a job runs with, optionally crashing at one step. */
export function handles(
  region: "default" | "eu" = "default",
  crash?: Crash,
  createsObjects = false,
) {
  const bindings =
    crash === undefined
      ? env
      : {
          ...env,
          DB: crashingD1(env.DB, crash),
          DB_EU: crashingD1(env.DB_EU, crash),
          ARTIFACTS: crashingBucket(env.ARTIFACTS, crash),
          ARTIFACTS_EU: crashingBucket(env.ARTIFACTS_EU, crash),
        };
  const regions = regionsFromEnv(bindings);
  const home = regions.get(region);
  const bucket = home.bucket;
  if (bucket === undefined) throw new Error("no bucket");
  return {
    regions,
    db: home.db,
    bucket,
    objects: objectsFor(region, { ...(crash ? { crash } : {}), createsObjects }),
  };
}

export const db = (region: "default" | "eu" = "default") => regionsFromEnv(env).get(region).db;
export const bucketOf = (region: "default" | "eu" = "default") =>
  region === "default" ? env.ARTIFACTS : env.ARTIFACTS_EU;

/** The object of an artifact, from the test's side. */
export function stubOf(id: string): DurableObjectStub<ArtifactDocuments> {
  // Direct calls go to the object as is; the afterEach check fails a test that reached an
  // object before `quiet` and let it set a platform alarm.
  touched.add(id);
  return env.DOCUMENTS.get(env.DOCUMENTS.idFromName(id));
}

/** Runs one store command inside the object, as its handlers do. */
export async function inside<T>(id: string, run: (object: ArtifactDocuments) => T): Promise<T> {
  await quiet(id);
  return runInDurableObject(stubOf(id), (object: ArtifactDocuments) => run(object));
}

export async function controlOf(id: string) {
  return (stubOf(id) as unknown as DataObjectRpc).lifecycleControl();
}

/** An artifact row in D1 (and its directory row), in `state`. */
export async function artifactRow(
  id: string,
  ownerId: string,
  options: { state?: "active" | "suspended" | "purging"; region?: "default" | "eu" } = {},
): Promise<void> {
  const region = options.region ?? "default";
  await db(region)
    .insert(schema.artifacts)
    .values({
      id,
      ownerId,
      type: "site",
      name: "Plan",
      state: options.state ?? "active",
      lifecycleGeneration: options.state === "purging" ? 2 : 1,
    });
  await regionsFromEnv(env)
    .global.insert(schema.artifactDirectory)
    .values({ id, region, createdAt: D1_NOW })
    .onConflictDoNothing();
}

/** D1's numbers for an artifact's data, or null. */
export async function dataRowOf(id: string, region: "default" | "eu" = "default") {
  const [row] = await db(region)
    .select()
    .from(schema.artifactData)
    .where(eq(schema.artifactData.artifactId, id));
  return row ?? null;
}

function envelopeOf(
  id: string,
  ownerId: string,
  numbers: { generation: number; epoch: number },
  region = "default",
): DataEnvelope {
  return {
    artifactId: id,
    region,
    ownerId,
    generation: numbers.generation,
    epoch: numbers.epoch,
    opId: lifecycleId(DATA_NOW),
  };
}

/**
 * An artifact with data: its row, its registered object (inventory and `artifact_data`), a
 * collection declared by the owner side and documents created by the owner and by `visitors`,
 * each through the store as the owner API and the page will.
 */
export async function withData(
  options: {
    ownerId?: string;
    visitors?: string[];
    documents?: number;
    state?: "active" | "suspended" | "purging";
    region?: "default" | "eu";
  } = {},
) {
  const id = artifactId();
  const ownerId = options.ownerId ?? `u_${crypto.randomUUID()}`;
  const region = options.region ?? "default";
  await artifactRow(id, ownerId, { state: options.state ?? "active", region });
  await registerDataObject(db(region), bucketOf(region), region, id, DATA_NOW);
  const numbers = { generation: 0, epoch: 0 };
  const context = { now: DATA_NOW, limits: LIFECYCLE_LIMITS };
  await inside(id, (object) => {
    const declared = object.store.declare(
      envelopeOf(id, ownerId, numbers, region),
      { kind: "owner" },
      { name: "notes", mode: "shared" },
      context,
    );
    if (!declared.ok) throw new Error(`declare: ${declared.ok || declared.code}`);
    for (let n = 0; n < (options.documents ?? 1); n += 1) {
      const made = object.store.create(
        envelopeOf(id, ownerId, numbers, region),
        { kind: "owner" },
        "notes",
        { n, by: OWNER_AUTHOR },
        context,
      );
      if (!made.ok) throw new Error(`create: ${made.code}`);
    }
    for (const visitor of options.visitors ?? []) {
      const made = object.store.create(
        envelopeOf(id, ownerId, numbers, region),
        { kind: "visitor", author: visitor, canWrite: true },
        "notes",
        { by: visitor },
        context,
      );
      if (!made.ok) throw new Error(`visitor create: ${made.code}`);
    }
  });
  return { id, ownerId, region };
}

/** Documents in the object, optionally only those a visitor created. */
export async function documentsOf(id: string, author?: string): Promise<number> {
  return inside(id, (object) => {
    const rows = object.store.inspect("pf_documents");
    return author === undefined ? rows.length : rows.filter((row) => row.author === author).length;
  });
}

/** A visitor's journal entry, as a grant's claim writes it (delivery 6). */
export async function claimJournal(
  userId: string,
  id: string,
  visitor: string,
  region: "default" | "eu" = "default",
): Promise<void> {
  const entry: JournalEntry = { visitorId: visitor, firstGrantAt: DATA_NOW };
  await bucketOf(region).put(journalKey(userId, id), JSON.stringify(entry));
}

export async function journalOf(
  userId: string,
  id: string,
  region: "default" | "eu" = "default",
): Promise<JournalEntry | null> {
  const found = await bucketOf(region).get(journalKey(userId, id));
  return found === null ? null : ((await found.json()) as JournalEntry);
}

/** The pending outbox rows of `topics`. */
export async function jobsOf(dbHandle: RegionalDb, topics: readonly string[], subject?: string) {
  const rows =
    subject === undefined
      ? await dbHandle.select().from(schema.outbox)
      : await dbHandle.select().from(schema.outbox).where(eq(schema.outbox.subject, subject));
  return rows.filter(
    (row) => topics.includes(row.topic) && (subject === undefined || row.subject === subject),
  );
}

const DATA_TOPICS = [
  "data_fence",
  "data_erase",
  "data_author_erasure",
  "data_reconcile",
  "data_resolve",
  "data_export",
] as const;

/**
 * Runs the region's data jobs about `subject` (every data job without it) until none is left
 * waiting now, as the queue consumer would: each through `runJob`, which deletes a finished row
 * (the acknowledgement). Returns the outcomes; a crash propagates.
 */
export async function drain(
  options: {
    region?: "default" | "eu";
    subject?: string;
    crash?: Crash;
    now?: number;
    rounds?: number;
    createsObjects?: boolean;
  } = {},
): Promise<string[]> {
  const region = options.region ?? "default";
  const now = options.now ?? DATA_NOW;
  const {
    db: handle,
    bucket,
    objects,
    regions,
  } = handles(region, options.crash, options.createsObjects);
  const outcomes: string[] = [];
  for (let round = 0; round < (options.rounds ?? 30); round += 1) {
    const due = (await jobsOf(handle, DATA_TOPICS, options.subject)).filter(
      (row) => row.availableAt <= now,
    );
    if (due.length === 0) return outcomes;
    for (const row of due) {
      const message: JobMessage = {
        id: row.id,
        topic: row.topic,
        ...(region === "default" ? {} : { region }),
      };
      const outcome = await runJob(handle, bucket, message, now, { data: objects, regions });
      outcomes.push(`${row.topic}:${outcome}`);
    }
  }
  return outcomes;
}

/** The quarantined state reconciliation recorded for the operator, as `data-resolve` takes it. */
export async function reviewedOf(id: string, region: "default" | "eu" = "default") {
  const [finding] = await db(region)
    .select({ state: schema.dataFindings.state })
    .from(schema.dataFindings)
    .where(eq(schema.dataFindings.artifactId, id));
  const state = finding?.state ? parseReviewed(finding.state) : null;
  if (state === null) throw new Error(`no reviewed state for ${id}`);
  return state;
}
