// An in-memory documents object for the artifact data protocols' tests (decision 0026, delivery
// 3): the thin shell delivery 4 builds over SQLite, here over maps. Every command reads state,
// calls the domain's decisions and writes their result in one transaction (an undo log replayed on
// a throw), and every terminal outcome is metered by the domain's `meter`; nothing here decides a
// rule of its own. Each primitive access counts one row, both in the command's cost and in an
// independent oracle (`accesses`) that no charge reads, so a path that escapes metering shows up as
// accesses nothing accounted for. Faults can be injected after the work of any mutation, and
// `evict` drops what only memory held.
import {
  ARTIFACT_DATA,
  type ArtifactDataLimits,
  type BulkCreate,
  type BulkReplace,
  type ChargeClass,
  type CollectionDeclaration,
  type CollectionMode,
  type DataControl,
  type DataCount,
  type DataDescription,
  type DataEnvelope,
  type DataFence,
  type DataQuery,
  type DataRefusalCode,
  type DayCounters,
  ERASED_EDITOR,
  type ExportCursor,
  type QuarantineReason,
  type StorageReport,
} from "@portifact/contracts/artifact-data";
import {
  admit,
  afterStep,
  applyFence,
  auditObligation,
  authorOf,
  bulkBodies,
  type Caller,
  type CollectionFacts,
  type Cost,
  cancelErase,
  chunkLeavesMore,
  chunkSize,
  commitErase,
  completes,
  createRefusal,
  cutPage,
  dayOf,
  declareCollection,
  declaredFields,
  describe,
  describeCollection,
  documentBody,
  type ExportDocument,
  type ExportPage,
  editorAfter,
  emptyDay,
  flushPending,
  growthRefusal,
  type IndexField,
  inbound,
  indexEntries,
  keyBefore,
  type LiveAttachment,
  liveCheck,
  liveReservation,
  type MutationActor,
  type MutationKind,
  type MutationPlan,
  type MutationReads,
  meter,
  minuteOf,
  mutationActorName,
  newAttachment,
  newControl,
  nextAlarm,
  nextBuild,
  nextValueCount,
  noPendingReads,
  OPERATION_ROW_BOUNDS,
  type OperationKind,
  operationKey,
  outbound,
  type PendingReads,
  pageOf,
  passLeftMore,
  payloadChanged,
  pendingDeadline,
  planConnect,
  planCount,
  planExport,
  planMatches,
  planMutation,
  planQuery,
  planRead,
  prepareErase,
  presentDocument,
  pruneAllowed,
  pruneCutoffs,
  quarantine,
  RETAINED_CLASSES,
  type RetainedClass,
  readScope,
  readyFields,
  receives,
  renewDecision,
  requestHash,
  resolveQuarantine,
  rollPending,
  type SettleDecision,
  sequenceAdvances,
  sequenceScope,
  settleDecision,
  subscribed,
  type Terminal,
  touched,
  uniqueValue,
  valueCountDeltas,
} from "../artifact-data/index.ts";

export interface Doc {
  collection: string;
  id: string;
  author: string;
  editor: string | null;
  created: number;
  updated: number;
  seq: number;
  unique: string | null;
  body: string;
  size: number;
  values: Record<string, string>;
}

interface Collection {
  mode: CollectionMode;
  uniqueKey: string | null;
  documents: number;
  bytes: number;
}

export interface OpRecord {
  actor: string;
  requestHash: string;
  state: "committed" | "aborted";
  kind: string;
  target: string;
  result: Record<string, number> | null;
  at: number;
}

export interface AuditRow {
  kind: string;
  detail: Record<string, number | boolean>;
  owner: string;
  state: "pending" | "delivered";
  at: number;
}

/** Everything the object keeps durably. */
export interface Durable {
  control: DataControl | null;
  collections: Map<string, Collection>;
  fields: IndexField[];
  documents: Map<string, Doc>;
  authorCounts: Map<string, number>;
  valueCounts: Map<string, number>;
  seq: Map<string, number>;
  ops: Map<string, OpRecord>;
  audit: Map<string, AuditRow>;
  barriers: Map<string, { at: number; complete: boolean }>;
  rates: Map<string, number>;
  days: Map<number, DayCounters>;
  /** Each visitor's rights row per day: `author \0 day`. */
  rights: Map<string, number>;
  ended: Map<string, { outcome: "committed" | "cancelled"; at: number }>;
  alarm: number | null;
}

/** The payload: what a whole erase deletes. Everything else is control and stays. */
const PAYLOAD = [
  "collections",
  "fields",
  "documents",
  "authorCounts",
  "valueCounts",
  "seq",
  "ops",
] as const;

function emptyDurable(): Durable {
  return {
    control: null,
    collections: new Map(),
    fields: [],
    documents: new Map(),
    authorCounts: new Map(),
    valueCounts: new Map(),
    seq: new Map(),
    ops: new Map(),
    audit: new Map(),
    barriers: new Map(),
    rates: new Map(),
    days: new Map(),
    rights: new Map(),
    ended: new Map(),
    alarm: null,
  };
}

type Replay = { kind: string; target: string; result: Record<string, number> | null };

export type Answer<T> =
  | { ok: true; value: T; cost: Cost; storage: StorageReport }
  | { ok: true; replayed: Replay; cost: Cost; storage: StorageReport }
  | { ok: false; code: DataRefusalCode; message: string; cost: Cost; storage: StorageReport };

class Failure extends Error {
  constructor(
    readonly code: DataRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(refusal: { code: DataRefusalCode; message: string }): never {
  throw new Failure(refusal.code, refusal.message);
}

export interface Socket {
  attachment: LiveAttachment;
  received: string[];
  closed: number | null;
}

/** One charged operation, for the tests. */
export interface ChargeEntry {
  kind: string;
  charge: ChargeClass;
  cost: Cost;
  usedBefore: number;
  dayAfter: number;
  /** Deferred housekeeping folded into a protected charge. */
  folded: number;
  failed: boolean;
}

export interface Faults {
  /** Throws after a mutation's work, before its charge, when it answers true. */
  afterWork?: (kind: MutationKind) => boolean;
}

type Context = { now: number; limits: ArtifactDataLimits };
type TopLevel = { control: DataControl | null; fields: IndexField[]; alarm: number | null };
type Proceed = Extract<MutationPlan, { decision: "proceed" }>;

const key2 = (...parts: (string | number)[]) => parts.join("\u0000");
const ACCOUNTED = ["growth", "read", "cleanup", "export", "rights", "protected"] as const;

export class MemoryObject {
  durable: Durable;
  pending: PendingReads = noPendingReads(0);
  /** Each caller's attempts in the current minute, in memory (one minute is kept). */
  attempts = new Map<string, number>();
  sockets = new Map<string, Socket>();
  charges: ChargeEntry[] = [];
  faults: Faults = {};
  /** The independent oracle: every row the store saw, never reset, read by no charge. */
  accesses = 0;
  /** Accounted rows that left the day counters: pruned day rows and pending lost to eviction. */
  retired = 0;
  #cost: Cost = { rowsRead: 0, rowsWritten: 0 };
  #ids = 0;
  /** The open transaction's undo log, or null outside one. */
  #undo: (() => void)[] | null = null;
  #raw: TopLevel = { control: null, fields: [], alarm: null };
  #active = 0;
  #bookkeeping = 0;
  /** Rows metering took (charged, counted or deferred): every access must reach it. */
  #metered = 0;
  /** Day rows metering wrote: each costs the stated fixed overhead (`COUNTER_WRITE_ROWS`). */
  counterWrites = 0;
  /** Every operation checked against its bound: a bound passed throws. */
  checked: { kind: OperationKind; cost: Cost; failed: boolean }[] = [];
  /** The bounds checked: `OPERATION_ROW_BOUNDS`, which a negative-control test may tighten. */
  rowBounds: Record<OperationKind, number> = { ...OPERATION_ROW_BOUNDS };

  constructor(readonly name = "obj") {
    this.durable = this.#instrument(emptyDurable());
  }

  // The instrumented store. Every map of `durable` counts its own reads (`get`, `has`, each entry
  // an iteration yields) and writes (`set`, `delete`), and `control`, `fields` and `alarm` count
  // through accessors, while a command is running; nested index values count where they are
  // written (`#tickValues`). A seek through an index counts the rows it returns plus its probe
  // (`#select`). Metering's own writes are bookkeeping: counted apart, as the stated fixed overhead
  // of each counter write. Nothing the object does to durable state escapes the count.

  #tick(rows: number, write: boolean): void {
    if (this.#active === 0 || this.#bookkeeping > 0 || rows === 0) return;
    if (write) this.#cost.rowsWritten += rows;
    else this.#cost.rowsRead += rows;
    this.accesses += rows;
  }

  /** Index value rows, which the model keeps inside their document. */
  #tickValues(rows: number): void {
    this.#tick(rows, true);
  }

  /** Runs object code against the store: accesses count only inside it. */
  #running<T>(work: () => T): T {
    const outer = this.#active === 0;
    const seen = this.accesses;
    const metered = this.#metered;
    this.#active += 1;
    let value: T;
    try {
      value = work();
    } finally {
      this.#active -= 1;
    }
    // No code path may touch the store without metering what it touched.
    if (outer && this.accesses - seen !== this.#metered - metered) {
      throw new Error(
        `unmetered access: the store saw ${this.accesses - seen} rows, metering took ${this.#metered - metered}`,
      );
    }
    return value;
  }

  /** Metering's own writes: bookkeeping, not counted as work. */
  #keeping<T>(work: () => T): T {
    this.#bookkeeping += 1;
    try {
      return work();
    } finally {
      this.#bookkeeping -= 1;
    }
  }

  /**
   * A seek through an index: the entries that match, in order, at most `limit`; it counts the
   * rows it returns plus its probe, as an index seek in SQLite reads them.
   */
  #select<K, V>(
    map: Map<K, V>,
    keep: (key: K, value: V) => boolean,
    options: { order?: (a: [K, V], b: [K, V]) => number; limit?: number } = {},
  ): [K, V][] {
    let rows = [...(Map.prototype.entries.call(map) as IterableIterator<[K, V]>)].filter(
      ([key, value]) => keep(key, value),
    );
    if (options.order !== undefined) rows.sort(options.order);
    if (options.limit !== undefined) rows = rows.slice(0, options.limit);
    this.#tick(rows.length + 1, false);
    return rows;
  }

  #newId(): string {
    this.#ids += 1;
    return `${this.name}${this.#ids}`.padStart(16, "x").slice(-16);
  }

  /**
   * A transaction: what it changed is undone when the function throws. Storage maps record every
   * `set` and `delete` in an undo log (`#watch`), an entry mutated in place is first replaced by a
   * copy (`#own`), so the logged value stays intact, and the top-level fields are restored from a
   * capture. The cost is the rows a command touches, not the size of the state.
   */
  #transaction<T>(work: () => T): T {
    const outer = this.#undo === null;
    const undo = this.#undo ?? [];
    this.#undo = undo;
    const mark = undo.length;
    const top = this.#capture();
    try {
      const value = work();
      if (outer) this.#undo = null;
      return value;
    } catch (error) {
      for (let index = undo.length - 1; index >= mark; index--) (undo[index] as () => void)();
      undo.length = mark;
      this.#restore(top);
      if (outer) this.#undo = null;
      throw error;
    }
  }

  #capture(): { maps: Record<string, unknown>; raw: TopLevel } {
    const maps: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(Object.getOwnPropertyDescriptors(this.durable))) {
      if ("value" in value) maps[name] = value.value;
    }
    return { maps, raw: { ...this.#raw } };
  }

  #restore(top: { maps: Record<string, unknown>; raw: TopLevel }): void {
    Object.assign(this.durable, top.maps);
    Object.assign(this.#raw, top.raw);
  }

  /** Counts every access of a storage map and records every change in the undo log. */
  #watch<K, V>(map: Map<K, V>): Map<K, V> {
    const note = (key: K) => {
      if (this.#undo === null) return;
      const had = Map.prototype.has.call(map, key);
      const prior = Map.prototype.get.call(map, key) as V;
      this.#undo.push(() => {
        if (had) Map.prototype.set.call(map, key, prior);
        else Map.prototype.delete.call(map, key);
      });
    };
    const define = (name: string | symbol, value: unknown) =>
      Object.defineProperty(map, name, { value, enumerable: false, configurable: true });
    const counted = <T>(iterator: Iterable<T>) => {
      const self = this;
      return (function* () {
        for (const item of iterator) {
          self.#tick(1, false);
          yield item;
        }
      })();
    };
    define("get", (key: K) => {
      this.#tick(1, false);
      return Map.prototype.get.call(map, key);
    });
    define("has", (key: K) => {
      this.#tick(1, false);
      return Map.prototype.has.call(map, key);
    });
    define("set", (key: K, value: V) => {
      this.#tick(1, true);
      note(key);
      return Map.prototype.set.call(map, key, value);
    });
    define("delete", (key: K) => {
      this.#tick(1, true);
      note(key);
      return Map.prototype.delete.call(map, key);
    });
    define("values", () => counted(Map.prototype.values.call(map) as Iterable<V>));
    define("keys", () => counted(Map.prototype.keys.call(map) as Iterable<K>));
    define("entries", () => counted(Map.prototype.entries.call(map) as Iterable<[K, V]>));
    define(Symbol.iterator, () => counted(Map.prototype.entries.call(map) as Iterable<[K, V]>));
    return map;
  }

  /** Watches every map and puts `control`, `fields` and `alarm` behind counting accessors. */
  #instrument(durable: Durable): Durable {
    for (const value of Object.values(durable)) if (value instanceof Map) this.#watch(value);
    for (const name of ["control", "fields", "alarm"] as const) {
      (this.#raw as Record<string, unknown>)[name] = durable[name];
      Object.defineProperty(durable, name, {
        enumerable: true,
        configurable: true,
        get: () => {
          this.#tick(1, false);
          return this.#raw[name];
        },
        set: (value: unknown) => {
          this.#tick(1, true);
          (this.#raw as Record<string, unknown>)[name] = value;
        },
      });
    }
    return durable;
  }

  /** An entry about to be mutated in place: replaced by its copy first, so the undo log holds the original. */
  #own<K, V>(map: Map<K, V>, key: K): V {
    const copy = structuredClone(map.get(key) as V);
    map.set(key, copy);
    return copy;
  }

  /**
   * The answer's storage report: the control record the command already holds and the file's size
   * (`databaseSize` on real storage), so it reads no rows and is not work.
   */
  #storage(): StorageReport {
    return this.#keeping(() => {
      const control = this.durable.control;
      return {
        generation: control?.generation ?? 0,
        seq: control?.storageSeq ?? 0,
        bytes: this.fileBytes(),
      };
    });
  }

  dataBytes(): number {
    let sum = 0;
    for (const collection of this.durable.collections.values()) sum += collection.bytes;
    return sum;
  }

  /** A model of the database file: documents and every control row at a fixed size. */
  fileBytes(): number {
    const d = this.durable;
    const rows =
      d.ops.size +
      d.audit.size +
      d.barriers.size +
      d.rates.size +
      d.days.size +
      d.ended.size +
      d.rights.size +
      d.valueCounts.size;
    return this.dataBytes() + 64 * (rows + d.documents.size) + 1024;
  }

  /** The rows the day counters, the pending usage and retired rows account for. */
  accounted(): number {
    let sum = this.retired + this.pending.rows + this.pending.deferred;
    for (const day of this.durable.days.values()) {
      for (const field of ACCOUNTED) sum += day[field];
    }
    return sum;
  }

  #dayRow(day: number): DayCounters {
    return this.durable.days.get(day) ?? emptyDay(day);
  }

  #used(charge: ChargeClass, now: number): number {
    const today = dayOf(now);
    const pending = this.pending.day === today ? this.pending.rows : 0;
    return this.#dayRow(today)[charge] + (charge === "read" ? pending : 0);
  }

  #rightsUsed(author: string, now: number): number {
    return this.durable.rights.get(key2(author, dayOf(now))) ?? 0;
  }

  #attempt(caller: MutationActor, now: number): number {
    if (caller.kind === "owner" || caller.kind === "erasure") return 0;
    const minute = minuteOf(now);
    const subject = key2(caller.kind === "visitor" ? caller.author : "readers", minute);
    if (!this.attempts.has(subject)) {
      for (const key of [...this.attempts.keys()]) {
        if (!key.endsWith(`\u0000${minute}`)) this.attempts.delete(key);
      }
    }
    const used = (this.attempts.get(subject) ?? 0) + 1;
    this.attempts.set(subject, used);
    return used;
  }

  /**
   * The one metering step of every terminal outcome: writes what `meter` decides (an earlier
   * day's pending usage, the charge or a synchronous flush, a visitor's rights row) and touches
   * the control record when a counter row was written by anything but the work's own charge.
   */
  #meter(
    terminal: Terminal,
    now: number,
    kind: OperationKind | null,
    failed = false,
  ): DayCounters | null {
    const cost = { ...this.#cost };
    this.#metered += cost.rowsRead + cost.rowsWritten;
    if (kind !== null) {
      this.checked.push({ kind, cost, failed });
      // A bound that can be passed is a defect: every test running the object fails on it.
      if (cost.rowsRead + cost.rowsWritten > this.rowBounds[kind]) {
        throw new Error(
          `${kind} measured ${cost.rowsRead + cost.rowsWritten} rows, past its bound`,
        );
      }
    }
    const last = this.#keeping(() => {
      const control = this.durable.control;
      const author = terminal.kind === "charged" ? (terminal.author ?? null) : null;
      const result = meter({
        terminal,
        cost,
        pending: this.pending,
        day: (day) => this.#dayRow(day),
        ...(author === null ? {} : { rightsUsed: this.#rightsUsed(author, now) }),
        bound: control !== null,
        now,
      });
      for (const day of result.days) this.durable.days.set(day.day, day);
      this.counterWrites += result.days.length;
      if (result.rights !== null) {
        this.durable.rights.set(key2(result.rights.author, dayOf(now)), result.rights.used);
      }
      this.pending = result.pending;
      if (terminal.kind !== "charged" && result.days.length > 0 && control !== null) {
        this.durable.control = touched(control, false);
      }
      return result.days.at(-1) ?? null;
    });
    this.#rearm(now);
    return last;
  }

  /**
   * Live work outside a command (a renewal, an inbound message, a notification): what it read is
   * metered as an uncharged outcome of its own, refused when `refused` says so.
   */
  #uncharged<T>(now: number, work: () => T, refused: (value: T) => boolean = () => false): T {
    const saved = this.#cost;
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    try {
      const value = work();
      this.#meterUncharged(refused(value), now, null);
      return value;
    } finally {
      this.#cost = saved;
    }
  }

  /** Meters an outcome that wrote nothing durable but may flush, in its own transaction. */
  #meterUncharged(refused: boolean, now: number, kind: OperationKind | null): void {
    this.#transaction(() => this.#meter({ kind: "uncharged", refused }, now, kind));
  }

  #charge(
    kind: string,
    charge: ChargeClass,
    now: number,
    failed: boolean,
    author: string | null = null,
    bound: OperationKind | null = null,
  ): void {
    const before = this.#keeping(() => ({
      used: author === null ? this.#used(charge, now) : this.#rightsUsed(author, now),
      folded: charge === "protected" ? this.pending.deferred : 0,
    }));
    const cost = { ...this.#cost };
    const day = this.#meter({ kind: "charged", charge, author }, now, bound, failed) as DayCounters;
    const dayAfter = this.#keeping(() =>
      author === null ? day[charge] : this.#rightsUsed(author, now),
    );
    this.charges.push({
      kind,
      charge,
      cost,
      usedBefore: before.used,
      dayAfter,
      folded: before.folded,
      failed,
    });
  }

  #protected(kind: string, now: number): void {
    this.#charge(kind, "protected", now, false, null, kind === "prune" ? "prune" : null);
  }

  #answer<T>(work: () => T): Answer<T> {
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    try {
      const value = work();
      if (value !== null && typeof value === "object" && "__replayed" in value) {
        const replayed = (value as unknown as { __replayed: Replay }).__replayed;
        return { ok: true, replayed, cost: { ...this.#cost }, storage: this.#storage() };
      }
      return { ok: true, value, cost: { ...this.#cost }, storage: this.#storage() };
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      return {
        ok: false,
        code: error.code,
        message: error.message,
        cost: { ...this.#cost },
        storage: this.#storage(),
      };
    }
  }

  #setControl(control: DataControl): void {
    this.durable.control = control;
  }

  #barred(author: string): boolean {
    return this.durable.barriers.has(author);
  }

  #facts(name: string): CollectionFacts | null {
    const collection = this.durable.collections.get(name);
    if (collection === undefined) return null;
    return { ...collection, fields: declaredFields(this.durable.fields, name) };
  }

  #reads(now: number, actor: MutationActor): MutationReads {
    let attempts: number | null = null;
    return {
      prior: (key) => this.durable.ops.get(key) ?? null,
      barred: (author) => this.#barred(author),
      collection: (name) => this.#facts(name),
      document: (collection, id) => {
        const doc = this.durable.documents.get(key2(collection, id));
        return doc === undefined ? null : { creator: doc.author, size: doc.size };
      },
      used: (charge) => this.#used(charge, now),
      rights: (author) => this.#rightsUsed(author, now),
      callerAttempts: () => {
        attempts ??= this.#attempt(actor, now);
        return attempts;
      },
      rate: (subject, kind, window) => this.durable.rates.get(key2(subject, kind, window)) ?? 0,
    };
  }

  /**
   * Sets the next alarm from the oldest row of each retained class (one index seek each) and the
   * pending deadline. Its accesses are protected bookkeeping, deferred to the next counter write
   * like an alarm's pruning, so scheduling never writes a day row of its own.
   */
  #rearm(now: number, more = false): void {
    const saved = this.#cost;
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    const d = this.durable;
    const oldest = <K, V>(
      map: Map<K, V>,
      age: (key: K, value: V) => number,
      keep = (_k: K, _v: V) => true,
    ) => {
      const [row] = this.#select(map, keep, {
        order: (a, b) => age(a[0], a[1]) - age(b[0], b[1]),
        limit: 1,
      });
      return row === undefined ? null : age(row[0], row[1]);
    };
    const part = (key: string, index: number) => Number(key.split("\u0000")[index]);
    const min = (...values: (number | null)[]) => {
      const present = values.filter((value): value is number => value !== null);
      return present.length === 0 ? null : Math.min(...present);
    };
    const deadlines = [...this.sockets.values()]
      .filter((socket) => socket.closed === null)
      .map((socket) => socket.attachment.deadline);
    const control = d.control;
    d.alarm = nextAlarm({
      control,
      deadlines,
      oldest: {
        operation: min(
          oldest(d.ops, (_k, v) => v.at),
          oldest(d.ended, (_k, v) => v.at),
        ),
        delivered: oldest(
          d.audit,
          (_k, v) => v.at,
          (_k, v) => v.state === "delivered",
        ),
        rateWindow: oldest(d.rates, (k) => part(k, 2)),
        day: min(
          oldest(d.days, (k) => k),
          oldest(d.rights, (k) => part(k, 1)),
        ),
      },
      more,
      pendingFlushAt: control === null ? null : pendingDeadline(this.pending),
      now,
    });
    const rows = this.#cost.rowsRead + this.#cost.rowsWritten;
    this.#metered += rows;
    this.pending = { ...this.pending, deferred: this.pending.deferred + rows };
    this.#cost = saved;
  }

  // The mutation shape.

  #mutation<T>(
    kind: MutationKind,
    envelope: DataEnvelope,
    actor: MutationActor,
    context: Context,
    request: unknown,
    extra: {
      collection?: string;
      documentId?: string;
      documentIds?: string[];
      newSize?: number;
      author?: string;
    },
    work: (plan: Proceed) => {
      value: T;
      documents: number;
      declared: boolean;
      detail?: Record<string, number | boolean>;
    },
    after?: (value: T) => void,
  ): Answer<T> {
    return this.#running(() => {
      let plan: MutationPlan | null = null;
      const now = context.now;
      const answer = this.#answer(() => {
        try {
          return this.#transaction(() => {
            plan = planMutation(
              this.durable.control,
              {
                kind,
                envelope,
                actor,
                now,
                limits: context.limits,
                hash: requestHash(request),
                ...extra,
              },
              this.#reads(now, actor),
            );
            if (plan.decision === "refused") fail(plan.refusal);
            if (plan.decision === "replayed") {
              return { __replayed: plan.answer } as unknown as T;
            }
            if (plan.binds) this.#setControl(plan.control);
            if (plan.rate !== null) this.#countRate(plan.rate);
            const done = work(plan);
            if (this.faults.afterWork?.(kind)) throw new Failure("conflict", "injected fault");
            const audit = auditObligation(
              kind,
              actor,
              done.detail ?? { documents: done.documents },
            );
            if (audit !== null) this.#audit(plan, envelope.ownerId, audit, now);
            this.durable.control = touched(
              this.durable.control as DataControl,
              payloadChanged({ documents: done.documents, declared: done.declared }),
            );
            this.#charge(kind, plan.charge, now, false, plan.rightsAuthor, kind);
            return done.value;
          });
        } catch (error) {
          const proceeded = plan as MutationPlan | null;
          if (proceeded !== null && proceeded.decision === "proceed") {
            this.#transaction(() => {
              if (this.durable.control === null) this.#setControl(proceeded.control);
              if (proceeded.rate !== null) this.#countRate(proceeded.rate);
              this.durable.control = touched(this.durable.control as DataControl, false);
              this.#charge(kind, proceeded.charge, now, true, proceeded.rightsAuthor, kind);
            });
          } else {
            this.#meterUncharged(true, now, kind);
          }
          throw error;
        }
      });
      if (answer.ok && "replayed" in answer) {
        const replayed = plan as MutationPlan | null;
        if (replayed?.decision === "replayed" && replayed.charge === "protected") {
          this.#transaction(() => this.#charge(kind, "protected", now, false, null, kind));
        } else {
          this.#meterUncharged(false, now, kind);
        }
        return { ...answer, storage: this.#storage() };
      }
      if (answer.ok) after?.(answer.value);
      return answer;
    });
  }

  #countRate(rate: { subject: string; kind: string; window: number }): void {
    const key = key2(rate.subject, rate.kind, rate.window);
    this.durable.rates.set(key, (this.durable.rates.get(key) ?? 0) + 1);
  }

  #record(
    plan: Proceed,
    actor: MutationActor,
    hash: string,
    kind: string,
    target: string,
    now: number,
    result: Record<string, number> | null = null,
  ): void {
    if (plan.key === null) return;
    this.durable.ops.set(plan.key, {
      actor: mutationActorName(actor),
      requestHash: hash,
      state: "committed",
      kind,
      target,
      result,
      at: now,
    });
  }

  #audit(
    plan: Proceed,
    owner: string,
    obligation: { kind: string; detail: Record<string, number | boolean> },
    now: number,
  ): void {
    if (plan.key === null || this.durable.audit.has(plan.key)) return;
    this.durable.audit.set(plan.key, { ...obligation, owner, state: "pending", at: now });
  }

  #advance(scope: string): number {
    if (!sequenceAdvances(scope, (author) => this.#barred(author))) return 0;
    const value = (this.durable.seq.get(scope) ?? 0) + 1;
    this.durable.seq.set(scope, value);
    return value;
  }

  #countValues(collection: string, deltas: { field: string; value: string; delta: number }[]) {
    for (const { field, value, delta } of deltas) {
      const key = key2(collection, field, value);
      const next = nextValueCount(this.durable.valueCounts.get(key) ?? 0, delta);
      if (next === null) this.durable.valueCounts.delete(key);
      else this.durable.valueCounts.set(key, next);
    }
  }

  /** Keeps a document's indexed values and the value counts in step with its body. */
  #index(doc: Doc): void {
    const fields = declaredFields(this.durable.fields, doc.collection);
    const body = JSON.parse(doc.body) as Record<string, unknown>;
    const before = Object.entries(doc.values).map(([field, value]) => ({ field, value }));
    const after = indexEntries(body, fields);
    this.#countValues(doc.collection, valueCountDeltas(before, after));
    doc.values = {};
    for (const entry of after) {
      this.#tickValues(1);
      doc.values[entry.field] = entry.value;
    }
  }

  #countAuthor(collection: string, author: string, delta: number): void {
    const key = key2(collection, author);
    this.durable.authorCounts.set(key, (this.durable.authorCounts.get(key) ?? 0) + delta);
  }

  #deleteDoc(doc: Doc): number {
    const d = this.durable;
    d.documents.delete(key2(doc.collection, doc.id));
    this.#tickValues(Object.keys(doc.values).length);
    this.#countValues(
      doc.collection,
      valueCountDeltas(
        Object.entries(doc.values).map(([field, value]) => ({ field, value })),
        [],
      ),
    );
    this.#countAuthor(doc.collection, doc.author, -1);
    const collection = this.#own(d.collections, doc.collection) as Collection;
    collection.documents -= 1;
    collection.bytes -= doc.size;
    return this.#advance(sequenceScope(collection.mode, doc.collection, doc.author));
  }

  #indexStep(): number {
    const field = nextBuild(this.durable.fields);
    if (field !== null) {
      const covered = this.#select(
        this.durable.documents,
        (_key, doc) =>
          doc.collection === field.collection && (field.cursor === null || doc.id > field.cursor),
        {
          order: (a, b) => (a[1].id < b[1].id ? -1 : 1),
          limit: ARTIFACT_DATA.caps.indexStepDocuments,
        },
      ).map(([, doc]) => doc);
      for (const found of covered) {
        if (found.values[field.field] !== undefined) continue;
        const doc = this.#own(this.durable.documents, key2(found.collection, found.id)) as Doc;
        const body = JSON.parse(doc.body) as Record<string, unknown>;
        const entries = indexEntries(body, [field.field]);
        this.#countValues(doc.collection, valueCountDeltas([], entries));
        for (const entry of entries) {
          this.#tickValues(1);
          doc.values[entry.field] = entry.value;
        }
      }
      const next = afterStep(
        field,
        covered.map((doc) => doc.id),
      );
      this.durable.fields = this.durable.fields.map((item) =>
        item.collection === field.collection && item.field === field.field ? next : item,
      );
    }
    return this.durable.fields.filter((item) => item.state === "building").length;
  }

  #unique(
    collection: string,
    facts: CollectionFacts,
    body: unknown,
    author: string,
    except: string | null,
    value: string | null = null,
  ): string | null {
    if (facts.uniqueKey === null) return null;
    let unique = value;
    if (unique === null) {
      const decided = uniqueValue(body as Record<string, unknown>, facts.uniqueKey);
      if (!decided.ok) fail(decided);
      unique = decided.value;
    }
    const taken = this.#select(
      this.durable.documents,
      (_key, doc) =>
        doc.collection === collection &&
        doc.author === author &&
        doc.unique === unique &&
        doc.id !== except,
      { limit: 1 },
    );
    if (taken.length > 0) fail({ code: "conflict", message: "already exists" });
    return unique;
  }

  #insert(
    collection: string,
    facts: CollectionFacts,
    author: string,
    text: string,
    size: number,
    unique: string | null,
    now: number,
  ): Doc {
    const doc: Doc = {
      collection,
      id: this.#newId(),
      author,
      editor: null,
      created: now,
      updated: now,
      seq: this.#advance(sequenceScope(facts.mode, collection, author)),
      unique,
      body: text,
      size,
      values: {},
    };
    this.durable.documents.set(key2(collection, doc.id), doc);
    this.#index(doc);
    this.#countAuthor(collection, author, 1);
    const stored = this.#own(this.durable.collections, collection) as Collection;
    stored.documents += 1;
    stored.bytes += size;
    return doc;
  }

  #growth(before: number, grew: number, limits: ArtifactDataLimits): void {
    const refused = growthRefusal(
      { dataBytes: this.dataBytes(), fileBefore: before, fileAfter: this.fileBytes(), grew },
      limits,
    );
    if (refused !== null) fail(refused);
  }

  #rewrite(
    doc: Doc,
    facts: CollectionFacts,
    text: string,
    size: number,
    unique: string | null,
    editor: string,
    now: number,
  ): number {
    const old = doc.size;
    doc.body = text;
    doc.size = size;
    doc.unique = unique;
    doc.updated = now;
    doc.editor = editorAfter(doc.author, editor);
    doc.seq = this.#advance(sequenceScope(facts.mode, doc.collection, doc.author));
    this.#index(doc);
    const stored = this.#own(this.durable.collections, doc.collection) as Collection;
    stored.bytes += size - old;
    return size - old;
  }

  // Owner side and page commands.

  declare(
    envelope: DataEnvelope,
    caller: Caller,
    declaration: CollectionDeclaration,
    context: Context,
  ): Answer<{ building: number }> {
    const request = ["declare", declaration];
    return this.#mutation("declare", envelope, caller, context, request, {}, (plan) => {
      const existing = this.#facts(declaration.name);
      const decided = declareCollection(
        existing,
        declaration,
        this.durable.collections.size,
        context.limits,
      );
      if (!decided.ok) fail(decided);
      if (decided.value.create) {
        this.durable.collections.set(declaration.name, {
          mode: declaration.mode,
          uniqueKey: declaration.uniqueKey ?? null,
          documents: 0,
          bytes: 0,
        });
      }
      for (const field of decided.value.addFields) {
        this.durable.fields = [
          ...this.durable.fields,
          { collection: declaration.name, field, state: "building", cursor: null },
        ];
      }
      const building = this.#indexStep();
      this.#record(plan, caller, requestHash(request), "collection", declaration.name, context.now);
      return {
        value: { building },
        documents: 0,
        declared: decided.value.create || decided.value.addFields.length > 0,
      };
    });
  }

  indexStep(
    envelope: DataEnvelope,
    caller: Caller,
    context: Context,
  ): Answer<{ building: number }> {
    const request = ["index_step"];
    return this.#mutation("index_step", envelope, caller, context, request, {}, (plan) => {
      const building = this.#indexStep();
      this.#record(plan, caller, requestHash(request), "index_step", "", context.now);
      return { value: { building }, documents: 0, declared: false, detail: { building } };
    });
  }

  create(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    body: unknown,
    context: Context,
  ): Answer<Record<string, unknown>> {
    const request = ["create", collection, body];
    let notice: { mode: CollectionMode; doc: Doc } | null = null;
    return this.#mutation(
      "create",
      envelope,
      caller,
      context,
      request,
      { collection },
      (plan) => {
        const facts = this.#facts(collection) as CollectionFacts;
        const full = createRefusal(facts, context.limits);
        if (full !== null) fail(full);
        const parsed = documentBody(body, context.limits.documentBytes);
        if (!parsed.ok) fail(parsed);
        const author = authorOf(caller) as string;
        const unique = this.#unique(collection, facts, body, author, null);
        const before = this.fileBytes();
        const doc = this.#insert(
          collection,
          facts,
          author,
          parsed.value.text,
          parsed.value.size,
          unique,
          context.now,
        );
        this.#growth(before, doc.size, context.limits);
        const target = `${collection}/${doc.id}`;
        this.#record(plan, caller, requestHash(request), "document", target, context.now);
        notice = { mode: facts.mode, doc: { ...doc } };
        return { value: presentDocument(doc), documents: 1, declared: false };
      },
      () => {
        if (notice !== null) this.#notify(notice.mode, notice.doc, "created", context.now);
      },
    );
  }

  replace(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    id: string,
    body: unknown,
    context: Context,
  ): Answer<Record<string, unknown>> {
    const request = ["replace", collection, id, body];
    const newSize = new TextEncoder().encode(JSON.stringify(body) ?? "").length;
    let notice: { mode: CollectionMode; doc: Doc } | null = null;
    return this.#mutation(
      "replace",
      envelope,
      caller,
      context,
      request,
      { collection, documentId: id, newSize },
      (plan) => {
        const facts = this.#facts(collection) as CollectionFacts;
        const doc = this.#own(this.durable.documents, key2(collection, id)) as Doc;
        const parsed = documentBody(body, context.limits.documentBytes);
        if (!parsed.ok) fail(parsed);
        const unique = this.#unique(collection, facts, body, doc.author, id);
        const before = this.fileBytes();
        const editor = authorOf(caller) as string;
        const grew = this.#rewrite(
          doc,
          facts,
          parsed.value.text,
          parsed.value.size,
          unique,
          editor,
          context.now,
        );
        this.#growth(before, grew, context.limits);
        const target = `${collection}/${id}`;
        this.#record(plan, caller, requestHash(request), "document", target, context.now);
        notice = { mode: facts.mode, doc: { ...doc } };
        return { value: presentDocument(doc), documents: 1, declared: false };
      },
      () => {
        if (notice !== null) this.#notify(notice.mode, notice.doc, "updated", context.now);
      },
    );
  }

  remove(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    id: string,
    context: Context,
  ): Answer<{ id: string }> {
    const request = ["remove", collection, id];
    let notice: { mode: CollectionMode; doc: Doc } | null = null;
    return this.#mutation(
      "remove",
      envelope,
      caller,
      context,
      request,
      { collection, documentId: id },
      (plan) => {
        const doc = this.durable.documents.get(key2(collection, id)) as Doc;
        const mode = (this.durable.collections.get(collection) as Collection).mode;
        const seq = this.#deleteDoc(doc);
        const target = `${collection}/${id}`;
        this.#record(plan, caller, requestHash(request), "deleted", target, context.now);
        notice = { mode, doc: { ...doc, seq } };
        return { value: { id }, documents: 1, declared: false };
      },
      () => {
        if (notice !== null) this.#notify(notice.mode, notice.doc, "deleted", context.now);
      },
    );
  }

  bulkCreate(
    envelope: DataEnvelope,
    caller: Caller,
    input: BulkCreate,
    context: Context,
  ): Answer<{ ids: string[] }> {
    const request = ["bulk_create", input];
    const notices: { mode: CollectionMode; doc: Doc }[] = [];
    return this.#mutation(
      "bulk_create",
      envelope,
      caller,
      context,
      request,
      { collection: input.collection },
      (plan) => {
        const facts = this.#facts(input.collection) as CollectionFacts;
        const author = authorOf(caller) as string;
        const bodies = bulkBodies(
          input.documents,
          facts.uniqueKey,
          input.documents.map(() => author),
          context.limits,
        );
        if (!bodies.ok) fail(bodies);
        const room = createRefusal(
          { ...facts, documents: facts.documents + bodies.value.length - 1 },
          context.limits,
        );
        if (room !== null) fail(room);
        const before = this.fileBytes();
        let grew = 0;
        const ids: string[] = [];
        for (const [index, item] of bodies.value.entries()) {
          const unique = this.#unique(
            input.collection,
            facts,
            input.documents[index],
            author,
            null,
            item.unique,
          );
          const doc = this.#insert(
            input.collection,
            facts,
            author,
            item.text,
            item.size,
            unique,
            context.now,
          );
          grew += doc.size;
          ids.push(doc.id);
          notices.push({ mode: facts.mode, doc: { ...doc } });
        }
        this.#growth(before, grew, context.limits);
        const hash = requestHash(request);
        this.#record(plan, caller, hash, "bulk_created", input.collection, context.now, {
          created: ids.length,
        });
        return { value: { ids }, documents: ids.length, declared: false };
      },
      () => {
        for (const notice of notices) this.#notify(notice.mode, notice.doc, "created", context.now);
      },
    );
  }

  bulkReplace(
    envelope: DataEnvelope,
    caller: Caller,
    input: BulkReplace,
    context: Context,
  ): Answer<{ replaced: number }> {
    const request = ["bulk_replace", input];
    const ids = input.documents.map((item) => item.id);
    const newSize = input.documents.reduce(
      (sum, item) => sum + new TextEncoder().encode(JSON.stringify(item.body)).length,
      0,
    );
    const notices: { mode: CollectionMode; doc: Doc }[] = [];
    return this.#mutation(
      "bulk_replace",
      envelope,
      caller,
      context,
      request,
      { collection: input.collection, documentIds: ids, newSize },
      (plan) => {
        const facts = this.#facts(input.collection) as CollectionFacts;
        const docs = ids.map(
          (id) => this.#own(this.durable.documents, key2(input.collection, id)) as Doc,
        );
        const bodies = bulkBodies(
          input.documents.map((item) => item.body),
          facts.uniqueKey,
          docs.map((doc) => doc.author),
          context.limits,
        );
        if (!bodies.ok) fail(bodies);
        const before = this.fileBytes();
        let grew = 0;
        const editor = authorOf(caller) as string;
        for (const [index, item] of bodies.value.entries()) {
          const doc = docs[index] as Doc;
          const unique = this.#unique(
            input.collection,
            facts,
            input.documents[index]?.body,
            doc.author,
            doc.id,
            item.unique,
          );
          grew += this.#rewrite(doc, facts, item.text, item.size, unique, editor, context.now);
          notices.push({ mode: facts.mode, doc: { ...doc } });
        }
        this.#growth(before, grew, context.limits);
        const hash = requestHash(request);
        this.#record(plan, caller, hash, "bulk_replaced", input.collection, context.now, {
          replaced: docs.length,
        });
        return { value: { replaced: docs.length }, documents: docs.length, declared: false };
      },
      () => {
        for (const notice of notices) this.#notify(notice.mode, notice.doc, "updated", context.now);
      },
    );
  }

  bulkRemove(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    ids: string[],
    context: Context,
  ): Answer<{ removed: number }> {
    const request = ["bulk_remove", collection, ids];
    const notices: { mode: CollectionMode; doc: Doc }[] = [];
    return this.#mutation(
      "bulk_remove",
      envelope,
      caller,
      context,
      request,
      { collection, documentIds: ids },
      (plan) => {
        const mode = (this.durable.collections.get(collection) as Collection).mode;
        let removed = 0;
        for (const id of ids) {
          // Every target was authorized by `planMutation`; one refused target refused them all.
          const doc = this.durable.documents.get(key2(collection, id)) as Doc;
          const seq = this.#deleteDoc(doc);
          removed += 1;
          notices.push({ mode, doc: { ...doc, seq } });
        }
        this.#record(plan, caller, requestHash(request), "bulk_deleted", collection, context.now, {
          removed,
        });
        return { value: { removed }, documents: removed, declared: false };
      },
      () => {
        for (const notice of notices) this.#notify(notice.mode, notice.doc, "deleted", context.now);
      },
    );
  }

  eraseAuthorChunk(
    envelope: DataEnvelope,
    author: string,
    requested: number,
    context: Context,
  ): Answer<{ documents: number; edits: number; more: boolean }> {
    const take = chunkSize(requested);
    const request = ["erase_author", author, take];
    const actor: MutationActor = { kind: "erasure" };
    const notices: { mode: CollectionMode; doc: Doc; kind: "deleted" | "updated" }[] = [];
    return this.#mutation(
      "erase_author_chunk",
      envelope,
      actor,
      context,
      request,
      { author },
      (plan) => {
        const d = this.durable;
        if (!d.barriers.has(author)) {
          d.barriers.set(author, { at: context.now, complete: false });
          for (const socket of this.sockets.values()) {
            if (socket.attachment.author === author) this.#close(socket, 4410);
          }
          d.seq.delete(`author:${author}`);
        }
        const created = this.#select(d.documents, (_key, doc) => doc.author === author, {
          order: (a, b) => (a[0] < b[0] ? -1 : 1),
          limit: take,
        }).map(([, doc]) => doc);
        for (const doc of created) {
          const mode = (d.collections.get(doc.collection) as Collection).mode;
          const seq = this.#deleteDoc(doc);
          notices.push({ mode, doc: { ...doc, seq }, kind: "deleted" });
        }
        const edited = this.#select(d.documents, (_key, doc) => doc.editor === author, {
          limit: take,
        }).map(([, doc]) => doc);
        for (const found of edited) {
          const doc = this.#own(d.documents, key2(found.collection, found.id)) as Doc;
          const mode = (d.collections.get(doc.collection) as Collection).mode;
          doc.editor = ERASED_EDITOR;
          doc.seq = this.#advance(sequenceScope(mode, doc.collection, doc.author));
          notices.push({ mode, doc: { ...doc }, kind: "updated" });
        }
        const ops = this.#select(d.ops, (_key, row) => row.actor === author, { limit: take });
        for (const [key] of ops) d.ops.delete(key);
        const mine = (key: string, part: number) => key.split("\u0000")[part] === author;
        const rates = this.#select(d.rates, (key) => mine(key, 0), { limit: take });
        for (const [key] of rates) d.rates.delete(key);
        const rights = this.#select(d.rights, (key) => mine(key, 0), { limit: take });
        for (const [key] of rights) d.rights.delete(key);
        let more = chunkLeavesMore(
          {
            documents: created.length,
            edits: edited.length,
            operations: ops.length,
            rates: rates.length,
            rights: rights.length,
          },
          take,
        );
        if (!more) {
          const left = {
            created: this.#select(d.documents, (_key, doc) => doc.author === author, { limit: 1 })
              .length,
            edited: this.#select(d.documents, (_key, doc) => doc.editor === author, { limit: 1 })
              .length,
            rights: this.#select(d.rights, (key) => mine(key, 0), { limit: 1 }).length,
          };
          more = !completes(left);
          if (!more) {
            d.seq.delete(`author:${author}`);
            for (const [key] of this.#select(d.authorCounts, (key) => mine(key, 1))) {
              d.authorCounts.delete(key);
            }
            d.barriers.set(author, {
              at: (d.barriers.get(author) as { at: number }).at,
              complete: true,
            });
          }
        }
        const result = { documents: created.length, edits: edited.length, more };
        this.#record(plan, actor, requestHash(request), "author_erased", author, context.now, {
          documents: created.length,
          edits: edited.length,
          more: more ? 1 : 0,
        });
        return {
          value: result,
          documents: created.length + edited.length,
          declared: false,
          detail: { documents: created.length, edits: edited.length },
        };
      },
      () => {
        for (const notice of notices) {
          this.#notify(notice.mode, notice.doc, notice.kind, context.now);
        }
      },
    );
  }

  // Reads.

  #readCommand<T>(
    envelope: DataEnvelope,
    caller: Caller,
    context: Context,
    kind: OperationKind,
    empty: () => T,
    work: () => T,
  ): Answer<T> {
    return this.#running(() => {
      const answer = this.#answer(() => {
        const plan = planRead({
          stored: this.durable.control,
          envelope,
          caller,
          limits: context.limits,
          callerReads: this.#attempt(caller, context.now),
          used: this.#used("read", context.now),
          barred: caller.kind === "visitor" && this.#barred(caller.author),
        });
        if (plan.decision === "empty") return empty();
        if (plan.decision === "refused") fail(plan.refusal);
        return work();
      });
      this.#meterUncharged(!answer.ok, context.now, kind);
      return { ...answer, storage: this.#storage() } as Answer<T>;
    });
  }

  /** Writes all pending usage now (the alarm's flush), an earlier day's into that day. */
  /**
   * The alarm's flush, through the same metering as everything else: an earlier day's reads into
   * that day, today's into today's row with deferred usage, each write's overhead under protected;
   * deferred usage alone stays pending.
   */
  flushReads(now: number): void {
    this.#running(() =>
      this.#keeping(() => {
        const control = this.durable.control;
        const result = flushPending({
          pending: this.pending,
          day: (day) => this.#dayRow(day),
          bound: control !== null,
          now,
        });
        for (const day of result.days) this.durable.days.set(day.day, day);
        this.counterWrites += result.days.length;
        this.pending = result.pending;
        if (result.days.length > 0 && control !== null) {
          this.durable.control = touched(control, false);
        }
      }),
    );
  }

  get(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    id: string,
    context: Context,
  ): Answer<Record<string, unknown>> {
    const missing = () => fail({ code: "not_found", message: "no such document" });
    return this.#readCommand(envelope, caller, context, "get", missing, () => {
      const facts = this.#facts(collection);
      if (facts === null) missing();
      const scope = readScope((facts as CollectionFacts).mode, caller);
      const doc = this.durable.documents.get(key2(collection, id));
      if (doc === undefined || scope === "none") return missing();
      if (scope === "own" && doc.author !== (caller as { author: string }).author) return missing();
      return presentDocument(doc);
    });
  }

  query(
    envelope: DataEnvelope,
    caller: Caller,
    query: DataQuery,
    context: Context,
  ): Answer<{ documents: Record<string, unknown>[]; next: string | null }> {
    return this.#readCommand(
      envelope,
      caller,
      context,
      "query",
      () => ({ documents: [], next: null }),
      () => {
        const facts = this.#facts(query.collection);
        if (facts === null) fail({ code: "not_found", message: "no such collection" });
        const planned = planQuery(
          query,
          (facts as CollectionFacts).mode,
          caller,
          readyFields(this.durable.fields, query.collection),
        );
        if (!planned.ok) fail(planned);
        const plan = planned.value;
        if (plan.kind === "empty") return { documents: [], next: null };
        const rows = this.#select(
          this.durable.documents,
          (_key, doc) => doc.collection === query.collection && planMatches(plan, doc),
          {
            order: ([, a], [, b]) => {
              const order =
                a.created === b.created ? (a.id < b.id ? -1 : 1) : a.created - b.created;
              return plan.descending ? -order : order;
            },
            limit: plan.fetch,
          },
        ).map(([, doc]) => doc);
        const page = pageOf(rows, plan.limit);
        return { documents: page.rows.map(presentDocument), next: page.next };
      },
    );
  }

  count(
    envelope: DataEnvelope,
    caller: Caller,
    count: DataCount,
    context: Context,
  ): Answer<{ documents: number }> {
    return this.#readCommand(
      envelope,
      caller,
      context,
      "count",
      () => ({ documents: 0 }),
      () => {
        if (caller.kind !== "owner") fail({ code: "forbidden", message: "owner side only" });
        const facts = this.#facts(count.collection);
        if (facts === null) fail({ code: "not_found", message: "no such collection" });
        const planned = planCount(
          count,
          caller,
          readyFields(this.durable.fields, count.collection),
        );
        if (!planned.ok) fail(planned);
        const plan = planned.value;
        if (plan.kind === "collection") return { documents: (facts as CollectionFacts).documents };
        const key =
          plan.kind === "author"
            ? key2(count.collection, plan.author)
            : key2(count.collection, plan.field, plan.value);
        const map = plan.kind === "author" ? this.durable.authorCounts : this.durable.valueCounts;
        return { documents: map.get(key) ?? 0 };
      },
    );
  }

  describe(envelope: DataEnvelope, caller: Caller, context: Context): Answer<DataDescription> {
    const emptyDescription = (): DataDescription => ({
      generation: envelope.generation,
      revision: 0,
      collections: [],
      today: emptyDay(dayOf(context.now)),
    });
    return this.#readCommand(envelope, caller, context, "describe", emptyDescription, () => {
      const fields = this.durable.fields;
      const collections = [...this.durable.collections.entries()].map(([name, facts]) =>
        describeCollection(name, facts, fields),
      );
      const control = this.durable.control as DataControl;
      const decided = describe(caller, {
        generation: control.generation,
        revision: control.payloadRevision,
        collections,
        today: this.#dayRow(dayOf(context.now)),
      });
      if (!decided.ok) fail(decided);
      return decided.value;
    });
  }

  #exportCommand(
    envelope: DataEnvelope,
    who: "owner" | "visitor" | "operator",
    author: string | null,
    after: ExportCursor | null,
    take: number,
    context: Context,
  ): Answer<ExportPage> {
    return this.#running(() => {
      const now = context.now;
      let charged = false;
      const answer = this.#answer(() =>
        this.#transaction(() => {
          const plan = planExport({
            stored: this.durable.control,
            envelope,
            who,
            limits: context.limits,
            used: (charge) =>
              author !== null && charge === "rights"
                ? this.#rightsUsed(author, now)
                : this.#used(charge, now),
            barred: author !== null && this.#barred(author),
          });
          if (plan.decision === "empty") return { rows: [], next: null, revision: 0, bytes: 0 };
          if (plan.decision === "refused") fail(plan.refusal);
          const candidates: ExportDocument[] = this.#select(
            this.durable.documents,
            (_key, doc) =>
              (author === null || doc.author === author) &&
              (after === null || keyBefore(after, doc)),
            {
              order: ([, a], [, b]) => (keyBefore(a, b) ? -1 : 1),
              limit: Math.min(take, ARTIFACT_DATA.caps.exportRows) + 1,
            },
          )
            .map(([, doc]) => doc)
            .map((doc) => ({
              collection: doc.collection,
              id: doc.id,
              by: doc.author,
              editedBy: doc.editor,
              created: doc.created,
              updated: doc.updated,
              body: doc.body,
            }));
          const control = this.durable.control as DataControl;
          const page = cutPage(candidates, take, control.payloadRevision);
          this.durable.control = touched(control, false);
          charged = true;
          this.#charge("export_page", plan.charge, now, false, author, "export_page");
          return page;
        }),
      );
      if (!charged || !answer.ok) this.#meterUncharged(!answer.ok, now, "export_page");
      return { ...answer, storage: this.#storage() } as Answer<ExportPage>;
    });
  }

  exportPage(
    envelope: DataEnvelope,
    caller: Caller,
    after: ExportCursor | null,
    take: number,
    context: Context,
    operator = false,
  ): Answer<ExportPage> {
    if (!operator && caller.kind !== "owner") {
      return this.#answer(() => fail({ code: "forbidden", message: "owner side only" }));
    }
    const who = operator ? "operator" : "owner";
    return this.#exportCommand(envelope, who, null, after, take, context);
  }

  exportMine(
    envelope: DataEnvelope,
    caller: Caller,
    after: ExportCursor | null,
    context: Context,
  ): Answer<ExportPage> {
    if (caller.kind !== "visitor") {
      return this.#answer(() =>
        fail({ code: "forbidden", message: "a grant holder's own export" }),
      );
    }
    const take = ARTIFACT_DATA.caps.exportRows;
    return this.#exportCommand(envelope, "visitor", caller.author, after, take, context);
  }

  // Lifecycle: protected work, measured and never refused for budget.

  /** Runs a control command: protected when it wrote, otherwise metered as uncharged. */
  #control<T>(now: number, kind: string, work: () => { value: T; wrote: boolean }): Answer<T> {
    return this.#running(() => {
      let wrote = false;
      const answer = this.#answer(() =>
        this.#transaction(() => {
          const done = work();
          if (done.wrote) {
            wrote = true;
            this.#protected(kind, now);
          }
          return done.value;
        }),
      );
      if (!wrote || !answer.ok) this.#meterUncharged(!answer.ok, now, null);
      return { ...answer, storage: this.#storage() } as Answer<T>;
    });
  }

  fence(
    envelope: DataEnvelope,
    fence: DataFence,
    now: number,
  ): Answer<{ epoch: number; held: boolean; ownerId: string }> {
    return this.#control(now, "fence", () => {
      const applied = applyFence(this.durable.control, envelope, fence, now);
      if (!applied.ok) fail(applied);
      const { control, repeated, cancelledErase, closeConnections } = applied.value;
      if (!repeated) {
        this.#setControl(control);
        if (cancelledErase !== null) {
          this.durable.ended.set(cancelledErase, { outcome: "cancelled", at: now });
        }
        if (closeConnections) this.closeAll(4003);
      }
      return {
        value: { epoch: control.epoch, held: control.hold !== null, ownerId: control.ownerId },
        wrote: !repeated,
      };
    });
  }

  quarantine(envelope: DataEnvelope, reason: QuarantineReason, now: number): Answer<boolean> {
    return this.#control(now, "quarantine", () => {
      const decided = quarantine(this.durable.control, envelope, reason, now);
      if (!decided.ok) fail(decided);
      if (decided.value.changed) {
        this.#setControl(decided.value.control);
        this.closeAll(4003);
      }
      return { value: decided.value.changed, wrote: decided.value.changed };
    });
  }

  resolveQuarantine(
    envelope: DataEnvelope,
    decision: "adopt" | "erase",
    now: number,
  ): Answer<null> {
    return this.#control(now, "resolve_quarantine", () => {
      const decided = resolveQuarantine(this.durable.control, envelope, decision);
      if (!decided.ok) fail(decided);
      if (decided.value.erasePayload) this.#erasePayload();
      if (decided.value.endedErase !== null) {
        this.durable.ended.set(decided.value.endedErase, { outcome: "committed", at: now });
      }
      this.#setControl(decided.value.control);
      return { value: null, wrote: true };
    });
  }

  /** Deletes every payload row, each counted: the work grows with the data, as it does in SQL. */
  #erasePayload(): void {
    const d = this.durable;
    // Every payload row is read and deleted: the work grows with the data, as it does in SQL.
    let rows = this.#raw.fields.length;
    for (const table of PAYLOAD) {
      if (table === "fields") continue;
      const map = d[table] as Map<unknown, unknown>;
      rows += map.size;
      if (table !== "documents") continue;
      for (const doc of Map.prototype.values.call(map) as Iterable<Doc>) {
        rows += Object.keys(doc.values).length;
      }
    }
    this.#tick(rows, false);
    this.#tick(rows, true);
    const fresh = emptyDurable();
    for (const table of PAYLOAD) {
      if (table === "fields") {
        this.#raw.fields = [];
        continue;
      }
      const map = this.#watch(fresh[table] as Map<unknown, unknown>);
      (d as unknown as Record<string, unknown>)[table] = map;
    }
    this.closeAll(4003);
  }

  #eraseStep(
    step: "prepare" | "commit" | "cancel",
    envelope: DataEnvelope,
    eraseId: string,
    now: number,
  ) {
    return this.#control(now, `erase_${step}`, () => {
      const ended = this.durable.ended.get(eraseId)?.outcome ?? null;
      const stored = this.durable.control;
      const intents = this.#dayRow(dayOf(now)).intents;
      const decided =
        step === "prepare"
          ? prepareErase(stored, envelope, eraseId, ended, now, intents)
          : step === "commit"
            ? commitErase(stored, envelope, eraseId, ended)
            : cancelErase(stored, envelope, eraseId, ended);
      if (!decided.ok) fail(decided);
      const result = decided.value;
      if (result.erasePayload) this.#erasePayload();
      if (result.ended !== null) {
        this.durable.ended.set(result.ended.id, { outcome: result.ended.outcome, at: now });
      }
      if (result.control !== null) this.#setControl(result.control);
      if (result.startsIntent) {
        const day = this.#dayRow(dayOf(now));
        this.durable.days.set(day.day, { ...day, intents: day.intents + 1 });
      }
      if (result.closeConnections) this.closeAll(4003);
      return { value: { outcome: result.outcome }, wrote: result.control !== null };
    });
  }

  prepareErase(envelope: DataEnvelope, eraseId: string, now: number) {
    return this.#eraseStep("prepare", envelope, eraseId, now);
  }

  commitErase(envelope: DataEnvelope, eraseId: string, now: number) {
    return this.#eraseStep("commit", envelope, eraseId, now);
  }

  cancelErase(envelope: DataEnvelope, eraseId: string, now: number) {
    return this.#eraseStep("cancel", envelope, eraseId, now);
  }

  // The audit relay.

  settle(
    envelope: DataEnvelope,
    actor: string,
    opId: string,
    now: number,
  ): SettleDecision["answer"] {
    const answer = this.#control(now, "settle", () => {
      const stored = this.durable.control;
      const verdict = admit(stored, envelope, { kind: "maintenance" });
      if (!verdict.ok) {
        return { value: { state: "refused" as const, code: verdict.code }, wrote: false };
      }
      const key = operationKey(actor, envelope.generation, opId);
      const decided = settleDecision(
        {
          obligation: this.durable.audit.get(key) ?? null,
          record: this.durable.ops.get(key) ?? null,
          barred: this.#barred(actor),
          currentGeneration: stored === null || stored.generation === envelope.generation,
        },
        opId,
        now,
      );
      if (decided.writeAborted) {
        this.#setControl(touched(stored ?? newControl(envelope, now), false));
        this.durable.ops.set(key, {
          actor,
          requestHash: "",
          state: "aborted",
          kind: "aborted",
          target: "",
          result: null,
          at: now,
        });
      }
      return { value: decided.answer, wrote: decided.writeAborted };
    });
    return (answer as { value: SettleDecision["answer"] }).value;
  }

  acknowledge(envelope: DataEnvelope, actor: string, opId: string, now: number): boolean {
    const answer = this.#control(now, "acknowledge", () => {
      const stored = this.durable.control;
      if (stored === null || !admit(stored, envelope, { kind: "maintenance" }).ok) {
        return { value: false, wrote: false };
      }
      const key = operationKey(actor, envelope.generation, opId);
      const found = this.durable.audit.get(key);
      if (found === undefined || found.state !== "pending") return { value: false, wrote: false };
      const row = this.#own(this.durable.audit, key) as AuditRow;
      row.state = "delivered";
      row.at = now;
      this.durable.control = touched(stored, false);
      return { value: true, wrote: true };
    });
    return (answer as { value: boolean }).value;
  }

  // Housekeeping.

  /** One alarm: closes expired connections, prunes a bounded pass of everything due, flushes. */
  alarm(now: number): { pruned: number } {
    return this.#running(() => {
      for (const socket of this.sockets.values()) {
        if (socket.closed === null && socket.attachment.deadline <= now) this.#close(socket, 4001);
      }
      const d = this.durable;
      let pruned = 0;
      let more = false;
      this.#cost = { rowsRead: 0, rowsWritten: 0 };
      this.#transaction(() => {
        if (pruneAllowed(d.control)) {
          const cut = pruneCutoffs(now);
          const cap = ARTIFACT_DATA.caps.pruneRows;
          const take = <K, V>(
            map: Map<K, V>,
            old: (key: K, value: V) => boolean,
            age: (key: K, value: V) => number,
            retire?: (value: V) => void,
          ) => {
            const rows = this.#select(map, old, {
              order: (a, b) => age(a[0], a[1]) - age(b[0], b[1]),
              limit: cap,
            });
            for (const [k, v] of rows) {
              retire?.(v);
              map.delete(k);
            }
            return rows.length;
          };
          const window = (key: string, part: number) => Number(key.split("\u0000")[part]);
          const classes: Record<RetainedClass, () => number> = {
            operations: () =>
              take(
                d.ops,
                (_k, v) => v.at < cut.operationsBefore,
                (_k, v) => v.at,
              ),
            ended: () =>
              take(
                d.ended,
                (_k, v) => v.at < cut.operationsBefore,
                (_k, v) => v.at,
              ),
            delivered: () =>
              take(
                d.audit,
                (_k, v) => v.state === "delivered" && v.at < cut.deliveredBefore,
                (_k, v) => v.at,
              ),
            rates: () =>
              take(
                d.rates,
                (k) => window(k, 2) < cut.rateWindowBefore,
                (k) => window(k, 2),
              ),
            days: () =>
              take(
                d.days,
                (k) => k < cut.dayBefore,
                (k) => k,
                (row) => {
                  for (const field of ACCOUNTED) this.retired += row[field];
                },
              ),
            rights: () =>
              take(
                d.rights,
                (k) => window(k, 1) < cut.dayBefore,
                (k) => window(k, 1),
              ),
          };
          const counts = RETAINED_CLASSES.map((name) => classes[name]());
          pruned = counts.reduce((sum, n) => sum + n, 0);
          more = passLeftMore(counts);
          if (pruned > 0) this.durable.control = touched(d.control as DataControl, false);
        }
        // Every pass is metered, an empty one's probes included: deferred, never a day row.
        this.#meter({ kind: "housekeeping" }, now, "prune");
      });
      this.flushReads(now);
      this.#rearm(now, more);
      return { pruned };
    });
  }

  /** An eviction: memory goes (pending usage, attempts, connections); storage stays. */
  evict(): void {
    this.retired += this.pending.rows + this.pending.deferred;
    this.pending = noPendingReads(0);
    this.attempts.clear();
    for (const socket of this.sockets.values()) if (socket.closed === null) socket.closed = 1001;
  }

  // Live.

  #close(socket: Socket, code: number): void {
    if (socket.closed === null) socket.closed = code;
  }

  closeAll(code: number): void {
    for (const socket of this.sockets.values()) this.#close(socket, code);
  }

  connect(
    envelope: DataEnvelope,
    author: string | null,
    principal: string,
    deadline: number,
    context: Context,
  ): Answer<string> {
    return this.#running(() => {
      const now = context.now;
      let charged = false;
      const answer = this.#answer(() =>
        this.#transaction(() => {
          const stored = this.durable.control;
          const open = [...this.sockets.values()].filter((socket) => socket.closed === null);
          const rate = { subject: author ?? "readers", kind: "connects", window: minuteOf(now) };
          const refused = planConnect({
            stored,
            envelope,
            barred: author !== null && this.#barred(author),
            deadline,
            now,
            open: open.length,
            openForAuthor: open.filter((socket) => socket.attachment.author === author).length,
            limits: context.limits,
            usedGrowth: this.#used("growth", now),
            connectsThisMinute:
              this.durable.rates.get(key2(rate.subject, rate.kind, rate.window)) ?? 0,
          });
          if (refused !== null) fail(refused);
          this.#countRate(rate);
          const control = stored as DataControl;
          this.durable.control = touched(control, false);
          const socketId = this.#newId();
          this.sockets.set(socketId, {
            attachment: newAttachment({
              socketId,
              author,
              principal,
              generation: control.generation,
              deadline,
              now,
              limits: context.limits,
            }),
            received: [],
            closed: null,
          });
          charged = true;
          this.#charge("connect", "growth", now, false);
          return socketId;
        }),
      );
      if (!charged || !answer.ok) this.#meterUncharged(true, now, null);
      return answer;
    });
  }

  renew(
    envelope: DataEnvelope,
    socketId: string,
    principal: string,
    deadline: number,
    context: Context,
  ): boolean {
    return this.#running(() =>
      this.#uncharged(
        context.now,
        () => this.#renew(envelope, socketId, principal, deadline, context),
        (ok) => !ok,
      ),
    );
  }

  #renew(
    envelope: DataEnvelope,
    socketId: string,
    principal: string,
    deadline: number,
    context: Context,
  ): boolean {
    {
      if (!admit(this.durable.control, envelope, { kind: "request", create: false }).ok)
        return false;
      const socket = this.sockets.get(socketId);
      if (socket === undefined || socket.closed !== null) return false;
      const decided = renewDecision(
        socket.attachment,
        principal,
        deadline,
        context.now,
        context.limits,
      );
      if ("close" in decided) {
        this.#close(socket, decided.close);
        return false;
      }
      if ("refused" in decided) return false;
      socket.attachment = decided.attachment;
      this.#rearm(context.now);
      return true;
    }
  }

  #live(socket: Socket, now: number): LiveAttachment | null {
    if (socket.closed !== null) return null;
    const author = socket.attachment.author;
    const checked = liveCheck(
      this.durable.control,
      socket.attachment,
      author !== null && this.durable.barriers.has(author),
      now,
    );
    if ("close" in checked) {
      this.#close(socket, checked.close);
      return null;
    }
    return checked.attachment;
  }

  /** Sends one message, reserving against today first when nothing is reserved today. */
  #send(socket: Socket, attachment: LiveAttachment, text: string, now: number): void {
    const bytes = new TextEncoder().encode(text).length;
    let decided = outbound(attachment, bytes, null, now);
    if ("reserve" in decided) {
      const saved = this.#cost;
      this.#cost = { rowsRead: 0, rowsWritten: 0 };
      let granted = 0;
      this.#transaction(() => {
        const day = this.#dayRow(dayOf(now));
        granted = liveReservation(day.live, attachment.liveMessagesPerDay);
        if (granted > 0) {
          this.durable.days.set(day.day, { ...day, live: day.live + granted });
          this.durable.control = touched(this.durable.control as DataControl, false);
          this.#protected("live_reservation", now);
        } else {
          this.#meter({ kind: "uncharged", refused: true }, now, null);
        }
      });
      this.#cost = saved;
      decided = outbound(attachment, bytes, granted, now);
    }
    if ("close" in decided) {
      this.#close(socket, decided.close);
      return;
    }
    if ("reserve" in decided) return;
    socket.attachment = decided.attachment;
    socket.received.push(text);
  }

  message(socketId: string, text: string, now: number): void {
    this.#running(() => this.#uncharged(now, () => this.#message(socketId, text, now)));
  }

  #message(socketId: string, text: string, now: number): void {
    {
      const socket = this.sockets.get(socketId);
      if (socket === undefined) return;
      const current = this.#live(socket, now);
      if (current === null) return;
      const received = inbound(current, new TextEncoder().encode(text).length);
      if ("close" in received) {
        this.#close(socket, received.close);
        return;
      }
      socket.attachment = received.attachment;
      let name = "";
      try {
        name = String((JSON.parse(text) as { subscribe?: unknown }).subscribe);
      } catch {
        name = "";
      }
      const collection = this.durable.collections.get(name);
      const caller: Caller =
        current.author === null
          ? { kind: "reader" }
          : { kind: "visitor", author: current.author, canWrite: false };
      if (collection === undefined || readScope(collection.mode, caller) === "none") {
        this.#send(socket, received.attachment, JSON.stringify({ error: "not_found" }), now);
        return;
      }
      const subscribedTo = subscribed(received.attachment, name);
      this.#send(socket, subscribedTo, JSON.stringify({ subscribed: name }), now);
    }
  }

  #notify(
    mode: CollectionMode,
    doc: Doc,
    kind: "created" | "updated" | "deleted",
    now: number,
  ): void {
    const text = JSON.stringify({
      collection: doc.collection,
      kind,
      id: doc.id,
      seq: doc.seq,
      by: doc.author,
    });
    if (this.sockets.size === 0) return;
    this.#uncharged(now, () => {
      for (const socket of this.sockets.values()) {
        const attachment = this.#live(socket, now);
        if (attachment === null || !receives(attachment, doc.collection, mode, doc.author))
          continue;
        this.#send(socket, attachment, text, now);
      }
    });
  }
}

/** A stable, comparable view of everything an author left in an object. */
export function authorTraces(object: MemoryObject, author: string) {
  const d = object.durable;
  return {
    documents: [...d.documents.values()].filter((doc) => doc.author === author).length,
    edits: [...d.documents.values()].filter((doc) => doc.editor === author).length,
    sequences: d.seq.has(`author:${author}`) ? 1 : 0,
    rates: [...d.rates.keys()].filter((key) => key.split("\u0000")[0] === author).length,
    operations: [...d.ops.values()].filter((row) => row.actor === author).length,
    counts: [...d.authorCounts.keys()].filter((key) => key.split("\u0000")[1] === author).length,
    connections: [...object.sockets.values()].filter(
      (socket) => socket.closed === null && socket.attachment.author === author,
    ).length,
    rights: [...d.rights.keys()].filter((key) => key.split("\u0000")[0] === author).length,
    /** Value-count rows no current document holds: values of removed or erased documents. */
    orphanValues: orphanValueCounts(object),
  };
}

/** Value-count rows that do not match the indexed values of the current documents exactly. */
export function orphanValueCounts(object: MemoryObject): number {
  const d = object.durable;
  const expected = new Map<string, number>();
  for (const doc of d.documents.values()) {
    for (const [field, value] of Object.entries(doc.values)) {
      const key = [doc.collection, field, value].join("\u0000");
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
  }
  let orphans = 0;
  for (const [key, count] of d.valueCounts) if (expected.get(key) !== count) orphans += 1;
  return orphans + [...expected.keys()].filter((key) => !d.valueCounts.has(key)).length;
}

/** Storage without the alarm, which the first pending usage arms: what "writes nothing" compares. */
export function rows(durable: Durable): Omit<Durable, "alarm"> {
  const { alarm: _alarm, ...rest } = structuredClone(durable);
  return rest;
}
