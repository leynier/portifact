// One artifact's documents (decision 0026, delivery 4): the thin shell over SQLite that the
// in-memory reference object (`@portifact/domain`'s `src/testing/artifact-data-object.ts`) models.
// Every command reads state, calls the domain's decisions and writes their result in one
// synchronous storage transaction (`transactionSync`), with nothing awaited between admission and
// the write; a failure after the work began rolls back and is charged in a second synchronous
// transaction; every terminal outcome is metered by the domain's `meter`. Nothing here decides a
// rule: a rule that is missing or wrong is fixed in `packages/domain/src/artifact-data`.
//
// Costs are the SQL cursors' own `rowsRead` and `rowsWritten`, read after each cursor is consumed,
// and file usage is `sql.databaseSize`. Every statement goes through `#exec`, which adds what the
// cursor measured to the running command's cost and to an independent oracle (`meters.accesses`)
// that no charge reads; the outermost scope of every entry point fails when a statement ran that
// no metering step took. Metering's own statements (the day counters, a visitor's rights row, the
// control record's sequence when only counters moved) are bookkeeping, measured apart
// (`meters.bookkeeping`) and stated as `COUNTER_WRITE_ROWS` per counter write.
import {
  ARTIFACT_DATA,
  type ArtifactDataLimits,
  type BulkCreate,
  type BulkReplace,
  type ChargeClass,
  type CollectionDeclaration,
  type CollectionMode,
  DataControl as ControlSchema,
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
  ArtifactDataLimits as LimitsSchema,
  type QuarantineReason,
  type StorageReport,
} from "@portifact/contracts/artifact-data";
import { logEvent } from "@portifact/domain";
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
  planMutation,
  planQuery,
  planRead,
  prepareErase,
  presentDocument,
  pruneAllowed,
  pruneCutoffs,
  type QueryPlan,
  quarantine,
  RETAINED_CLASSES,
  type RetainedClass,
  readScope,
  receives,
  refuse,
  renewDecision,
  requestHash,
  resolveQuarantine,
  type SettleDecision,
  sequenceAdvances,
  sequenceScope,
  settleDecision,
  subscribed,
  type Terminal,
  touched,
  uniqueValue,
  valueCountDeltas,
} from "@portifact/domain/artifact-data";
import { MIGRATIONS, PAYLOAD_TABLES, SCHEMA_PROBE, SCHEMA_V1, SCHEMA_VERSION } from "./schema.ts";

/** The storage the object runs on: a Durable Object's (`ctx.storage`). */
export interface StoreStorage {
  readonly sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
}

/** Where the next alarm goes: the object's storage in production, a recorder in tests. */
export interface Scheduler {
  /** Sets (a time) or deletes (null) the one alarm. May throw; the next command sets it again. */
  set(at: number | null): void;
}

/** One hibernatable WebSocket, as the object uses it. */
export interface SocketPort {
  send(text: string): void;
  close(code: number): void;
  serializeAttachment(value: unknown): void;
}

/** A socket rebuilt after hibernation: its port and the attachment it carried. */
export interface WokenSocket {
  port: SocketPort;
  attachment: LiveAttachment;
}

/** One charged operation, recorded only when the instrument keeps them (tests). */
export interface ChargeEntry {
  kind: string;
  charge: ChargeClass;
  cost: Cost;
  usedBefore: number;
  dayAfter: number;
  folded: number;
  failed: boolean;
}

/**
 * Measurement that outlives one instance of the store: the oracle (every row the cursors
 * measured outside bookkeeping), the rows metering took, counter writes and the rows their own
 * statements measured, usage that left the day counters (pruned day rows, pending usage an
 * eviction lost) and the cold starts. Tests keep one across evictions and hibernation; production
 * keeps the counts only.
 */
export class Instrument {
  accesses = 0;
  metered = 0;
  counterWrites = 0;
  /** Rows metering's own statements measured: stated as `COUNTER_WRITE_ROWS` per counter write. */
  bookkeeping = 0;
  retired = 0;
  /** Rows measured by entry points a storage fault ended, which no counter holds (also retired). */
  lost = 0;
  /** Rows each wake's cold start read. */
  coldStarts: number[] = [];
  charges: ChargeEntry[] = [];
  checked: { kind: OperationKind; cost: Cost; failed: boolean }[] = [];
  constructor(readonly record = false) {}
}

export interface Faults {
  /** Throws after a mutation's work, before its charge, when it answers true. */
  afterWork?: (kind: MutationKind) => boolean;
  /** Throws instead of running a statement when it answers true: a storage failure. */
  statement?: (query: string) => boolean;
}

export interface StoreOptions {
  storage: StoreStorage;
  scheduler: Scheduler;
  /** Creates and accepts a hibernatable socket for a new connection. */
  accept: (socketId: string) => SocketPort;
  /** Sockets that survived hibernation, with their attachments. */
  woken?: readonly WokenSocket[];
  /** Document and socket IDs: 12 random bytes in base64url unless a test injects them. */
  ids?: () => string;
  instrument?: Instrument;
  /** A bound passed throws (tests) or is logged (production). */
  strictBounds?: boolean;
}

type Context = { now: number; limits: ArtifactDataLimits };
/** What the object keeps in memory about storage, restored when a transaction rolls back. */
interface Memory {
  pending: PendingReads;
  metered: number;
  counterWrites: number;
  bookkeeping: number;
  retired: number;
  charges: number;
  checked: number;
}
type Proceed = Extract<MutationPlan, { decision: "proceed" }>;
type Row = Record<string, SqlStorageValue>;

/** A stored document, as the object reads it. */
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

type Replay = { kind: string; target: string; result: Record<string, number> | null };

export type Answer<T> =
  | { ok: true; value: T; cost: Cost; storage: StorageReport }
  | { ok: true; replayed: Replay; cost: Cost; storage: StorageReport }
  | { ok: false; code: DataRefusalCode; message: string; cost: Cost; storage: StorageReport };

export interface LiveSocket {
  port: SocketPort;
  attachment: LiveAttachment;
  closed: number | null;
}

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

/** The largest attachment a hibernatable socket keeps. */
export const ATTACHMENT_BYTES = 16_384;

const ACCOUNTED = ["growth", "read", "cleanup", "export", "rights", "protected"] as const;
const DAY_COLUMNS = [
  "growth",
  "read",
  "cleanup",
  "export",
  "rights",
  "protected",
  "live",
  "refused",
  "intents",
] as const;

/** A document or socket ID: 12 random bytes in base64url (`DocumentId`). */
export function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_");
}

const num = (value: SqlStorageValue | undefined): number => Number(value ?? 0);
const str = (value: SqlStorageValue | undefined): string => String(value ?? "");
const optional = (value: SqlStorageValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

export function docOf(row: Row): Doc {
  return {
    collection: str(row.collection),
    id: str(row.id),
    author: str(row.author),
    editor: optional(row.editor),
    created: num(row.created),
    updated: num(row.updated),
    seq: num(row.seq),
    unique: optional(row.unique_value),
    body: str(row.body),
    size: num(row.size),
    values: JSON.parse(str(row.vals)) as Record<string, string>,
  };
}

export function dayOfRow(row: Row): DayCounters {
  const day = emptyDay(num(row.day));
  for (const column of DAY_COLUMNS) day[column] = num(row[column]);
  return day;
}

export function fieldOf(row: Row): IndexField {
  return {
    collection: str(row.collection),
    field: str(row.field),
    state: str(row.state) as "building" | "ready",
    cursor: optional(row.cursor),
  };
}

const DOC_COLUMNS =
  "collection, id, author, editor, created, updated, seq, unique_value, body, size, vals";

export class DocumentsStore {
  pending: PendingReads = noPendingReads(0);
  /** Each caller's attempts in the current minute, in memory (one minute is kept). */
  attempts = new Map<string, number>();
  readonly sockets = new Map<string, LiveSocket>();
  faults: Faults = {};
  /** The bounds checked: `OPERATION_ROW_BOUNDS`, which a negative-control test may tighten. */
  rowBounds: Record<OperationKind, number> = { ...OPERATION_ROW_BOUNDS };
  readonly meters: Instrument;
  readonly #storage: StoreStorage;
  readonly #sql: SqlStorage;
  readonly #scheduler: Scheduler;
  readonly #accept: (socketId: string) => SocketPort;
  readonly #ids: () => string;
  readonly #strict: boolean;
  #cost: Cost = { rowsRead: 0, rowsWritten: 0 };
  #active = 0;
  #bookkeeping = 0;
  /** Whether the schema exists (undefined: probe it). */
  #schema: boolean | undefined;
  /** The control record as stored (undefined: read it). */
  #control: DataControl | null | undefined;
  /** The alarm as last set (undefined: unknown, so the next re-arm sets it). */
  #alarmAt: number | null | undefined;
  /** The alarm handler's pass left more: read by its own re-arm only. */
  #more = false;
  /** The running entry point's time, for the re-arm at its end. */
  #now = 0;

  constructor(options: StoreOptions) {
    this.#storage = options.storage;
    this.#sql = options.storage.sql;
    this.#scheduler = options.scheduler;
    this.#accept = options.accept;
    this.#ids = options.ids ?? randomId;
    this.#strict = options.strictBounds ?? false;
    this.meters = options.instrument ?? new Instrument();
    for (const woken of options.woken ?? []) {
      this.sockets.set(woken.attachment.socketId, {
        port: woken.port,
        attachment: woken.attachment,
        closed: null,
      });
    }
    this.#wake();
  }

  // Storage access. Every statement goes through `#exec`, which measures its cursor.

  /**
   * The cold start: one known metadata row (`SCHEMA_PROBE`), never a scan of `sqlite_schema`. An
   * object no write ever bound has no tables and stays that way until its first binding write.
   * What it read is protected housekeeping, deferred like an alarm's pruning.
   */
  #wake(): void {
    const before = this.meters.accesses;
    this.#active += 1;
    try {
      this.#schema = this.#probe();
    } finally {
      this.#active -= 1;
    }
    const rows = this.#cost.rowsRead + this.#cost.rowsWritten;
    this.meters.coldStarts.push(rows);
    this.meters.metered += this.meters.accesses - before;
    this.pending = { ...this.pending, deferred: this.pending.deferred + rows };
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
  }

  /** Whether the schema exists, migrating an older one; a newer one fails closed. */
  #probe(): boolean {
    let version: number;
    try {
      const [row] = this.#exec(SCHEMA_PROBE);
      version = row === undefined ? 0 : num(row.value);
    } catch (error) {
      if (String(error).includes("no such table")) return false;
      throw error;
    }
    if (version > SCHEMA_VERSION) throw new Error("the stored schema is newer than this code");
    if (version < SCHEMA_VERSION) {
      this.#storage.transactionSync(() => {
        for (let next = version + 1; next <= SCHEMA_VERSION; next++) {
          for (const statement of MIGRATIONS[next] ?? []) this.#exec(statement);
        }
        this.#exec(
          "INSERT INTO pf_meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          String(SCHEMA_VERSION),
        );
      });
    }
    return true;
  }

  #hasSchema(): boolean {
    this.#schema ??= this.#probe();
    return this.#schema;
  }

  /** Creates the schema in the binding write's own transaction. */
  #ensureSchema(): void {
    if (this.#hasSchema()) return;
    for (const statement of SCHEMA_V1) this.#exec(statement);
    this.#exec("INSERT INTO pf_meta (key, value) VALUES ('schema', ?)", String(SCHEMA_VERSION));
    this.#schema = true;
  }

  /** Runs one statement and measures it: its cursor is consumed before its counters are read. */
  #exec(query: string, ...binds: SqlStorageValue[]): Row[] {
    if (this.faults.statement?.(query)) throw new Error("injected storage fault");
    const cursor = this.#sql.exec(query, ...binds);
    const rows = cursor.toArray() as Row[];
    this.#measure(cursor.rowsRead, cursor.rowsWritten);
    return rows;
  }

  /** A read: nothing on an object without a schema. */
  #read(query: string, ...binds: SqlStorageValue[]): Row[] {
    if (!this.#hasSchema()) return [];
    return this.#exec(query, ...binds);
  }

  #measure(read: number, written: number): void {
    if (this.#bookkeeping > 0) {
      this.meters.bookkeeping += read + written;
      return;
    }
    this.#cost.rowsRead += read;
    this.#cost.rowsWritten += written;
    this.meters.accesses += read + written;
  }

  /**
   * Runs an entry point: its re-arm at the end, and, for the outermost scope, the check that every
   * row a cursor measured reached a metering step.
   */
  #running<T>(now: number, work: () => T): T {
    const outer = this.#active === 0;
    if (outer) this.#now = now;
    const seen = this.meters.accesses;
    const metered = this.meters.metered;
    this.#active += 1;
    let value: T;
    try {
      value = work();
    } catch (error) {
      if (outer) this.#lose(seen, metered);
      throw error;
    } finally {
      this.#active -= 1;
    }
    if (outer) {
      // The command is done and answered whatever the scheduler does: a storage fault while
      // computing the next alarm loses those rows and sets nothing, so the alarm stays as it
      // was and the next entry point computes and sets it.
      const before = { seen: this.meters.accesses, metered: this.meters.metered };
      try {
        this.#rearm(this.#more);
      } catch {
        this.#lose(before.seen, before.metered);
      }
      this.#more = false;
    }
    this.#checkMetered(outer, seen, metered);
    return value;
  }

  /**
   * A storage fault ended the entry point (anything it throws that is not a refusal). Storage
   * rolled back and the object's memory about storage followed it (`#restore`); the rows the
   * fault's entry point measured without a metering step reaching a committed counter are lost:
   * no counter holds them and no allowance is debited for them. They are counted, so the oracle
   * still accounts for every measured row, and what the object cached from storage is dropped.
   * Decision 0026, implementation note 11.
   */
  #lose(seen: number, metered: number): void {
    const rows = this.meters.accesses - seen - (this.meters.metered - metered);
    this.meters.lost += rows;
    this.meters.retired += rows;
    this.meters.metered += rows;
    this.#control = undefined;
    this.#schema = undefined;
    this.#more = false;
  }

  /** The outermost scope's oracle: every row a cursor measured reached a metering step. */
  #checkMetered(outer: boolean, seen: number, metered: number): void {
    if (outer && this.meters.accesses - seen !== this.meters.metered - metered) {
      throw new Error(
        `unmetered access: the cursors measured ${this.meters.accesses - seen} rows, metering took ${this.meters.metered - metered}`,
      );
    }
  }

  #keeping<T>(work: () => T): T {
    this.#bookkeeping += 1;
    try {
      return work();
    } finally {
      this.#bookkeeping -= 1;
    }
  }

  /**
   * One storage transaction. A throw rolls the storage back (a nested one to its savepoint),
   * drops what the object cached from storage, which is read again, and puts what the object
   * keeps in memory about storage back as it was (`#memory`). Attempts and sockets are not storage
   * and are not rolled back.
   */
  #transaction<T>(work: () => T): T {
    const memo = this.#memory();
    try {
      return this.#storage.transactionSync(work);
    } catch (error) {
      this.#control = undefined;
      this.#schema = undefined;
      this.#restore(memo);
      throw error;
    }
  }

  /**
   * What the object keeps in memory about storage: pending usage and the meters. It follows the
   * transaction, so a rollback leaves it as storage is. The oracle's `accesses` stays: those rows
   * were read and written, and the entry point charges them in a later transaction or, when a
   * storage fault ends it, counts them as lost (`#lose`).
   */
  #memory(): Memory {
    const m = this.meters;
    return {
      pending: this.pending,
      metered: m.metered,
      counterWrites: m.counterWrites,
      bookkeeping: m.bookkeeping,
      retired: m.retired,
      charges: m.charges.length,
      checked: m.checked.length,
    };
  }

  #restore(memo: Memory): void {
    const m = this.meters;
    this.pending = memo.pending;
    m.metered = memo.metered;
    m.counterWrites = memo.counterWrites;
    m.bookkeeping = memo.bookkeeping;
    m.retired = memo.retired;
    m.charges.length = memo.charges;
    m.checked.length = memo.checked;
  }

  // The control record.

  #readControl(): DataControl | null {
    if (this.#control === undefined) {
      const [row] = this.#read("SELECT value FROM pf_meta WHERE key = 'control'");
      this.#control = row === undefined ? null : ControlSchema.parse(JSON.parse(str(row.value)));
    }
    return this.#control;
  }

  #setControl(control: DataControl): void {
    this.#ensureSchema();
    this.#exec(
      "INSERT INTO pf_meta (key, value) VALUES ('control', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(control),
    );
    this.#control = control;
  }

  /** The control record as stored, for tests and diagnostics. */
  controlRecord(): DataControl | null {
    const [row] = this.inspect("pf_meta").filter((item) => item.key === "control");
    return row === undefined ? null : (JSON.parse(str(row.value)) as DataControl);
  }

  /** The storage report every answer carries, for an answer the store did not make itself. */
  currentReport(): StorageReport {
    return this.#storageReport();
  }

  #storageReport(): StorageReport {
    return this.#keeping(() => {
      const control = this.#readControl();
      return {
        generation: control?.generation ?? 0,
        seq: control?.storageSeq ?? 0,
        bytes: this.fileBytes(),
      };
    });
  }

  /** The database file's size, every index and control record included. */
  fileBytes(): number {
    return this.#sql.databaseSize;
  }

  #dataBytes(): number {
    const [row] = this.#read("SELECT coalesce(sum(bytes), 0) AS bytes FROM pf_collections");
    return num(row?.bytes);
  }

  // Counters.

  #dayRow(day: number): DayCounters {
    const [row] = this.#read("SELECT * FROM pf_days WHERE day = ?", day);
    return row === undefined ? emptyDay(day) : dayOfRow(row);
  }

  #writeDay(day: DayCounters): void {
    this.#exec(
      `INSERT INTO pf_days (day, ${DAY_COLUMNS.join(", ")}) VALUES (?, ${DAY_COLUMNS.map(() => "?").join(", ")})
       ON CONFLICT(day) DO UPDATE SET ${DAY_COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ")}`,
      day.day,
      ...DAY_COLUMNS.map((column) => day[column]),
    );
  }

  #used(charge: ChargeClass, now: number): number {
    const today = dayOf(now);
    const pending = this.pending.day === today ? this.pending.rows : 0;
    return this.#dayRow(today)[charge] + (charge === "read" ? pending : 0);
  }

  #rightsUsed(author: string, now: number): number {
    const [row] = this.#read(
      "SELECT used FROM pf_rights WHERE author = ? AND day = ?",
      author,
      dayOf(now),
    );
    return num(row?.used);
  }

  #attempt(caller: MutationActor, now: number): number {
    if (caller.kind === "owner" || caller.kind === "erasure") return 0;
    const minute = minuteOf(now);
    const subject = `${caller.kind === "visitor" ? caller.author : "readers"}\u0000${minute}`;
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
    this.meters.metered += cost.rowsRead + cost.rowsWritten;
    if (kind !== null) {
      if (this.meters.record) this.meters.checked.push({ kind, cost, failed });
      const rows = cost.rowsRead + cost.rowsWritten;
      if (rows > this.rowBounds[kind]) {
        if (this.#strict) throw new Error(`${kind} measured ${rows} rows, past its bound`);
        logEvent("error", "artifact_data_bound_passed");
      }
    }
    return this.#keeping(() => {
      const control = this.#readControl();
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
      for (const day of result.days) this.#writeDay(day);
      this.meters.counterWrites += result.days.length;
      if (result.rights !== null) {
        this.#exec(
          "INSERT INTO pf_rights (author, day, used) VALUES (?, ?, ?) ON CONFLICT(author, day) DO UPDATE SET used = excluded.used",
          result.rights.author,
          dayOf(now),
          result.rights.used,
        );
      }
      this.pending = result.pending;
      if (terminal.kind !== "charged" && result.days.length > 0 && control !== null) {
        this.#setControl(touched(control, false));
      }
      return result.days.at(-1) ?? null;
    });
  }

  /** Live work outside a command, metered as an uncharged outcome of its own. */
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
    const before = this.meters.record
      ? this.#keeping(() => ({
          used: author === null ? this.#used(charge, now) : this.#rightsUsed(author, now),
          folded: charge === "protected" ? this.pending.deferred : 0,
        }))
      : null;
    const cost = { ...this.#cost };
    const day = this.#meter({ kind: "charged", charge, author }, now, bound, failed);
    if (before === null || day === null) return;
    const dayAfter = this.#keeping(() =>
      author === null ? day[charge] : this.#rightsUsed(author, now),
    );
    this.meters.charges.push({
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
    this.#charge(kind, "protected", now, false);
  }

  #answer<T>(work: () => T): Answer<T> {
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    try {
      const value = work();
      if (value !== null && typeof value === "object" && "__replayed" in value) {
        const replayed = (value as unknown as { __replayed: Replay }).__replayed;
        return { ok: true, replayed, cost: { ...this.#cost }, storage: this.#storageReport() };
      }
      return { ok: true, value, cost: { ...this.#cost }, storage: this.#storageReport() };
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      return {
        ok: false,
        code: error.code,
        message: error.message,
        cost: { ...this.#cost },
        storage: this.#storageReport(),
      };
    }
  }

  /** Limits the platform cannot hold are refused whatever plan sent them. */
  #limitsRefusal(limits: ArtifactDataLimits) {
    return LimitsSchema.safeParse(limits).success
      ? null
      : refuse("invalid_input", "these limits are outside what the object can hold");
  }

  // Reads the decisions need.

  #barred(author: string): boolean {
    return this.#read("SELECT 1 FROM pf_barriers WHERE author = ?", author).length > 0;
  }

  /** A collection's fields in declaration order: a primary key seek, ordered here (no sort). */
  #fieldsOf(collection: string): IndexField[] {
    return byPosition(
      this.#read(
        "SELECT collection, field, state, cursor, position FROM pf_fields WHERE collection = ?",
        collection,
      ),
    ).map(fieldOf);
  }

  #facts(name: string): CollectionFacts | null {
    const [row] = this.#read(
      "SELECT mode, unique_key, documents, bytes FROM pf_collections WHERE name = ?",
      name,
    );
    if (row === undefined) return null;
    return {
      mode: str(row.mode) as CollectionMode,
      uniqueKey: optional(row.unique_key),
      documents: num(row.documents),
      bytes: num(row.bytes),
      fields: this.#fieldsOf(name).map((field) => field.field),
    };
  }

  #document(collection: string, id: string): Doc | null {
    const [row] = this.#read(
      `SELECT ${DOC_COLUMNS} FROM pf_documents WHERE collection = ? AND id = ?`,
      collection,
      id,
    );
    return row === undefined ? null : docOf(row);
  }

  #reads(now: number, actor: MutationActor): MutationReads {
    let attempts: number | null = null;
    return {
      prior: (key) => {
        const [row] = this.#read(
          "SELECT request_hash, state, kind, target, result FROM pf_ops WHERE key = ?",
          key,
        );
        if (row === undefined) return null;
        return {
          requestHash: str(row.request_hash),
          state: str(row.state) as "committed" | "aborted",
          kind: str(row.kind),
          target: str(row.target),
          result:
            row.result === null ? null : (JSON.parse(str(row.result)) as Record<string, number>),
        };
      },
      barred: (author) => this.#barred(author),
      collection: (name) => this.#facts(name),
      document: (collection, id) => {
        const [row] = this.#read(
          "SELECT author, size FROM pf_documents WHERE collection = ? AND id = ?",
          collection,
          id,
        );
        return row === undefined ? null : { creator: str(row.author), size: num(row.size) };
      },
      used: (charge) => this.#used(charge, now),
      rights: (author) => this.#rightsUsed(author, now),
      callerAttempts: () => {
        attempts ??= this.#attempt(actor, now);
        return attempts;
      },
      rate: (subject, kind, window) => {
        const [row] = this.#read(
          "SELECT count FROM pf_rates WHERE subject = ? AND kind = ? AND window = ?",
          subject,
          kind,
          window,
        );
        return num(row?.count);
      },
    };
  }

  /**
   * The one alarm scheduler: retention (each retained class's oldest row, one seek through its
   * age index each, only when pruning is allowed), pending flushes and connection deadlines,
   * through the domain's `nextAlarm`. What it read is protected bookkeeping deferred to the next
   * counter write; the alarm is set only when it moved, and a failed set leaves it unknown so the
   * next entry point sets it again.
   */
  #rearm(more: boolean): void {
    const saved = this.#cost;
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    const control = this.#readControl();
    const first = (query: string) => {
      const [row] = this.#read(query);
      return row === undefined ? null : num(row.age);
    };
    const min = (...values: (number | null)[]) => {
      const present = values.filter((value): value is number => value !== null);
      return present.length === 0 ? null : Math.min(...present);
    };
    const oldest = pruneAllowed(control)
      ? {
          operation: min(
            first("SELECT at AS age FROM pf_ops ORDER BY at LIMIT 1"),
            first("SELECT at AS age FROM pf_ended ORDER BY at LIMIT 1"),
          ),
          delivered: first(
            "SELECT at AS age FROM pf_audit WHERE state = 'delivered' ORDER BY at LIMIT 1",
          ),
          rateWindow: first("SELECT window AS age FROM pf_rates ORDER BY window LIMIT 1"),
          day: min(
            first("SELECT day AS age FROM pf_days ORDER BY day LIMIT 1"),
            first("SELECT day AS age FROM pf_rights ORDER BY day LIMIT 1"),
          ),
        }
      : { operation: null, delivered: null, rateWindow: null, day: null };
    const deadlines = [...this.sockets.values()]
      .filter((socket) => socket.closed === null)
      .map((socket) => socket.attachment.deadline);
    const at = nextAlarm({
      control,
      deadlines,
      oldest,
      more,
      pendingFlushAt: control === null ? null : pendingDeadline(this.pending),
      now: this.#now,
    });
    const rows = this.#cost.rowsRead + this.#cost.rowsWritten;
    this.meters.metered += rows;
    this.pending = { ...this.pending, deferred: this.pending.deferred + rows };
    this.#cost = saved;
    if (at === this.#alarmAt) return;
    try {
      this.#scheduler.set(at);
      this.#alarmAt = at;
    } catch {
      this.#alarmAt = undefined;
    }
  }

  /** The alarm as this instance last set it (undefined when unknown). */
  get alarmAt(): number | null | undefined {
    return this.#alarmAt;
  }

  /** The platform's alarm, read once at wake by the Durable Object, so re-arming can skip a set. */
  knownAlarm(at: number | null): void {
    this.#alarmAt = at;
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
      /** Bytes the documents grew by; unset by work that adds no document bytes. */
      grew?: number;
    },
    after?: (value: T) => void,
  ): Answer<T> {
    return this.#running(context.now, () => {
      let plan: MutationPlan | null = null;
      const now = context.now;
      const answer = this.#answer(() => {
        const limits = this.#limitsRefusal(context.limits);
        if (limits !== null) {
          this.#meterUncharged(true, now, kind);
          fail(limits);
        }
        try {
          return this.#transaction(() => {
            const fileBefore = this.fileBytes();
            plan = planMutation(
              this.#readControl(),
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
            this.#setControl(
              touched(
                this.#readControl() as DataControl,
                payloadChanged({ documents: done.documents, declared: done.declared }),
              ),
            );
            // Size is judged for work charged to growth, and only for it: cleanup, rights and
            // protected work (a replacement that does not grow its document, a removal, an
            // erasure) is never refused for size, so it always finishes at the cap.
            const growing = plan.charge === "growth";
            const dataBytes = growing ? this.#dataBytes() : 0;
            this.#charge(kind, plan.charge, now, false, plan.rightsAuthor, kind);
            if (growing) {
              // The measured file after every write of the transaction, the charge's included.
              const refused = growthRefusal(
                { dataBytes, fileBefore, fileAfter: this.fileBytes(), grew: done.grew ?? 0 },
                context.limits,
              );
              if (refused !== null) fail(refused);
            }
            return done.value;
          });
        } catch (error) {
          const proceeded = plan as MutationPlan | null;
          if (proceeded !== null && proceeded.decision === "proceed") {
            this.#transaction(() => {
              if (this.#readControl() === null) this.#setControl(proceeded.control);
              if (proceeded.rate !== null) this.#countRate(proceeded.rate);
              this.#setControl(touched(this.#readControl() as DataControl, false));
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
        return { ...answer, storage: this.#storageReport() };
      }
      if (answer.ok) after?.(answer.value);
      return answer;
    });
  }

  /**
   * Deletes the rows a seek found, each by its key: three measured rows a row (the seek's, the
   * lookup's and the delete's), where `DELETE ... WHERE key IN (SELECT ...)` measures six.
   */
  #deleteFound(table: string, keys: readonly string[], found: Row[]): Row[] {
    const where = keys.map((key) => `${key} = ?`).join(" AND ");
    for (const row of found) {
      this.#exec(
        `DELETE FROM ${table} WHERE ${where}`,
        ...keys.map((key) => row[key] as SqlStorageValue),
      );
    }
    return found;
  }

  #countRate(rate: { subject: string; kind: string; window: number }): void {
    this.#exec(
      `INSERT INTO pf_rates (subject, kind, window, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(subject, kind, window) DO UPDATE SET count = count + 1`,
      rate.subject,
      rate.kind,
      rate.window,
    );
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
    this.#exec(
      `INSERT INTO pf_ops (key, actor, request_hash, state, kind, target, result, at)
       VALUES (?, ?, ?, 'committed', ?, ?, ?, ?)`,
      plan.key,
      mutationActorName(actor),
      hash,
      kind,
      target,
      result === null ? null : JSON.stringify(result),
      now,
    );
  }

  #audit(
    plan: Proceed,
    owner: string,
    obligation: { kind: string; detail: Record<string, number | boolean> },
    now: number,
  ): void {
    if (plan.key === null) return;
    this.#exec(
      `INSERT INTO pf_audit (key, kind, detail, owner, state, at) VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(key) DO NOTHING`,
      plan.key,
      obligation.kind,
      JSON.stringify(obligation.detail),
      owner,
      now,
    );
  }

  #advance(scope: string): number {
    if (!sequenceAdvances(scope, (author) => this.#barred(author))) return 0;
    const [row] = this.#exec(
      `INSERT INTO pf_seq (scope, value) VALUES (?, 1)
       ON CONFLICT(scope) DO UPDATE SET value = value + 1 RETURNING value`,
      scope,
    );
    return num(row?.value);
  }

  #countValues(collection: string, deltas: { field: string; value: string; delta: number }[]) {
    for (const { field, value, delta } of deltas) {
      const [row] = this.#exec(
        "SELECT count FROM pf_value_counts WHERE collection = ? AND field = ? AND value = ?",
        collection,
        field,
        value,
      );
      const next = nextValueCount(num(row?.count), delta);
      if (next === null) {
        this.#exec(
          "DELETE FROM pf_value_counts WHERE collection = ? AND field = ? AND value = ?",
          collection,
          field,
          value,
        );
      } else {
        this.#exec(
          `INSERT INTO pf_value_counts (collection, field, value, count) VALUES (?, ?, ?, ?)
           ON CONFLICT(collection, field, value) DO UPDATE SET count = excluded.count`,
          collection,
          field,
          value,
          next,
        );
      }
    }
  }

  /** Writes a document's indexed values: those it no longer holds go, new ones come. */
  #writeValues(doc: Doc, after: Record<string, string>): void {
    for (const [field, value] of Object.entries(doc.values)) {
      if (after[field] === value) continue;
      this.#exec(
        "DELETE FROM pf_values WHERE collection = ? AND field = ? AND value = ? AND created = ? AND id = ?",
        doc.collection,
        field,
        value,
        doc.created,
        doc.id,
      );
    }
    for (const [field, value] of Object.entries(after)) {
      if (doc.values[field] === value) continue;
      this.#exec(
        "INSERT INTO pf_values (collection, field, value, created, id) VALUES (?, ?, ?, ?, ?)",
        doc.collection,
        field,
        value,
        doc.created,
        doc.id,
      );
    }
  }

  /** Keeps a document's indexed values and the value counts in step with its body. */
  #index(doc: Doc): Record<string, string> {
    const fields = this.#fieldsOf(doc.collection).map((field) => field.field);
    const body = JSON.parse(doc.body) as Record<string, unknown>;
    const before = Object.entries(doc.values).map(([field, value]) => ({ field, value }));
    const entries = indexEntries(body, fields);
    this.#countValues(doc.collection, valueCountDeltas(before, entries));
    const after: Record<string, string> = {};
    for (const entry of entries) after[entry.field] = entry.value;
    this.#writeValues(doc, after);
    return after;
  }

  #countAuthor(collection: string, author: string, delta: number): void {
    this.#exec(
      `INSERT INTO pf_author_counts (collection, author, count) VALUES (?, ?, ?)
       ON CONFLICT(collection, author) DO UPDATE SET count = count + excluded.count`,
      collection,
      author,
      delta,
    );
  }

  #collectionMode(name: string): CollectionMode {
    const [row] = this.#exec("SELECT mode FROM pf_collections WHERE name = ?", name);
    return str(row?.mode) as CollectionMode;
  }

  #addToCollection(name: string, documents: number, bytes: number): void {
    this.#exec(
      "UPDATE pf_collections SET documents = documents + ?, bytes = bytes + ? WHERE name = ?",
      documents,
      bytes,
      name,
    );
  }

  #deleteDoc(doc: Doc, mode: CollectionMode): number {
    this.#exec("DELETE FROM pf_documents WHERE collection = ? AND id = ?", doc.collection, doc.id);
    this.#writeValues(doc, {});
    this.#countValues(
      doc.collection,
      valueCountDeltas(
        Object.entries(doc.values).map(([field, value]) => ({ field, value })),
        [],
      ),
    );
    this.#countAuthor(doc.collection, doc.author, -1);
    this.#addToCollection(doc.collection, -1, -doc.size);
    return this.#advance(sequenceScope(mode, doc.collection, doc.author));
  }

  #indexStep(): number {
    const [first] = this.#read(
      "SELECT collection, field, state, cursor FROM pf_fields WHERE state = 'building' ORDER BY collection, field LIMIT 1",
    );
    const field = first === undefined ? null : nextBuild([fieldOf(first)]);
    if (field !== null) {
      const covered = this.#exec(
        `SELECT ${DOC_COLUMNS} FROM pf_documents WHERE collection = ? AND id > ? ORDER BY id LIMIT ?`,
        field.collection,
        field.cursor ?? "",
        ARTIFACT_DATA.caps.indexStepDocuments,
      ).map(docOf);
      for (const doc of covered) {
        if (doc.values[field.field] !== undefined) continue;
        const entries = indexEntries(JSON.parse(doc.body) as Record<string, unknown>, [
          field.field,
        ]);
        if (entries.length === 0) continue;
        this.#countValues(doc.collection, valueCountDeltas([], entries));
        const after = { ...doc.values };
        for (const entry of entries) after[entry.field] = entry.value;
        this.#writeValues(doc, after);
        this.#exec(
          "UPDATE pf_documents SET vals = ? WHERE collection = ? AND id = ?",
          JSON.stringify(after),
          doc.collection,
          doc.id,
        );
      }
      const next = afterStep(
        field,
        covered.map((doc) => doc.id),
      );
      this.#exec(
        "UPDATE pf_fields SET state = ?, cursor = ? WHERE collection = ? AND field = ?",
        next.state,
        next.cursor,
        next.collection,
        next.field,
      );
    }
    const [row] = this.#read("SELECT count(*) AS n FROM pf_fields WHERE state = 'building'");
    return num(row?.n);
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
    const taken = this.#exec(
      `SELECT id FROM pf_documents
       WHERE collection = ? AND author = ? AND unique_value = ? AND id != ? LIMIT 1`,
      collection,
      author,
      unique,
      except ?? "",
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
      id: this.#ids(),
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
    doc.values = this.#index(doc);
    this.#exec(
      `INSERT INTO pf_documents (${DOC_COLUMNS}) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      collection,
      doc.id,
      author,
      now,
      now,
      doc.seq,
      unique,
      text,
      size,
      JSON.stringify(doc.values),
    );
    this.#countAuthor(collection, author, 1);
    this.#addToCollection(collection, 1, size);
    return doc;
  }

  #rewrite(
    doc: Doc,
    mode: CollectionMode,
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
    doc.seq = this.#advance(sequenceScope(mode, doc.collection, doc.author));
    doc.values = this.#index(doc);
    this.#exec(
      `UPDATE pf_documents SET body = ?, size = ?, unique_value = ?, updated = ?, editor = ?, seq = ?, vals = ?
       WHERE collection = ? AND id = ?`,
      text,
      size,
      unique,
      now,
      doc.editor,
      doc.seq,
      JSON.stringify(doc.values),
      doc.collection,
      doc.id,
    );
    this.#addToCollection(doc.collection, 0, size - old);
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
      const [count] = this.#read("SELECT count(*) AS n FROM pf_collections");
      const decided = declareCollection(existing, declaration, num(count?.n), context.limits);
      if (!decided.ok) fail(decided);
      if (decided.value.create) {
        const [position] = this.#read(
          "SELECT coalesce(max(position), -1) + 1 AS p FROM pf_collections",
        );
        this.#exec(
          "INSERT INTO pf_collections (name, mode, unique_key, documents, bytes, position) VALUES (?, ?, ?, 0, 0, ?)",
          declaration.name,
          declaration.mode,
          declaration.uniqueKey ?? null,
          num(position?.p),
        );
      }
      if (decided.value.addFields.length > 0) {
        const [position] = this.#read("SELECT coalesce(max(position), -1) + 1 AS p FROM pf_fields");
        let next = num(position?.p);
        for (const field of decided.value.addFields) {
          this.#exec(
            "INSERT INTO pf_fields (collection, field, state, cursor, position) VALUES (?, ?, 'building', NULL, ?)",
            declaration.name,
            field,
            next,
          );
          next += 1;
        }
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
    const notices: { mode: CollectionMode; doc: Doc }[] = [];
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
        const doc = this.#insert(
          collection,
          facts,
          author,
          parsed.value.text,
          parsed.value.size,
          unique,
          context.now,
        );
        const target = `${collection}/${doc.id}`;
        this.#record(plan, caller, requestHash(request), "document", target, context.now);
        notices.push({ mode: facts.mode, doc: { ...doc } });
        return { value: presentDocument(doc), documents: 1, declared: false, grew: doc.size };
      },
      () => {
        for (const notice of notices) this.#notify(notice.mode, notice.doc, "created", context.now);
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
    const notices: { mode: CollectionMode; doc: Doc }[] = [];
    return this.#mutation(
      "replace",
      envelope,
      caller,
      context,
      request,
      { collection, documentId: id, newSize },
      (plan) => {
        const facts = this.#facts(collection) as CollectionFacts;
        const doc = this.#document(collection, id) as Doc;
        const parsed = documentBody(body, context.limits.documentBytes);
        if (!parsed.ok) fail(parsed);
        const unique = this.#unique(collection, facts, body, doc.author, id);
        const editor = authorOf(caller) as string;
        const grew = this.#rewrite(
          doc,
          facts.mode,
          parsed.value.text,
          parsed.value.size,
          unique,
          editor,
          context.now,
        );
        const target = `${collection}/${id}`;
        this.#record(plan, caller, requestHash(request), "document", target, context.now);
        notices.push({ mode: facts.mode, doc: { ...doc } });
        return { value: presentDocument(doc), documents: 1, declared: false, grew };
      },
      () => {
        for (const notice of notices) this.#notify(notice.mode, notice.doc, "updated", context.now);
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
    const notices: { mode: CollectionMode; doc: Doc }[] = [];
    return this.#mutation(
      "remove",
      envelope,
      caller,
      context,
      request,
      { collection, documentId: id },
      (plan) => {
        const doc = this.#document(collection, id) as Doc;
        const mode = this.#collectionMode(collection);
        const seq = this.#deleteDoc(doc, mode);
        const target = `${collection}/${id}`;
        this.#record(plan, caller, requestHash(request), "deleted", target, context.now);
        notices.push({ mode, doc: { ...doc, seq } });
        return { value: { id }, documents: 1, declared: false };
      },
      () => {
        for (const notice of notices) this.#notify(notice.mode, notice.doc, "deleted", context.now);
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
        const hash = requestHash(request);
        this.#record(plan, caller, hash, "bulk_created", input.collection, context.now, {
          created: ids.length,
        });
        return { value: { ids }, documents: ids.length, declared: false, grew };
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
        const docs = ids.map((id) => this.#document(input.collection, id) as Doc);
        const bodies = bulkBodies(
          input.documents.map((item) => item.body),
          facts.uniqueKey,
          docs.map((doc) => doc.author),
          context.limits,
        );
        if (!bodies.ok) fail(bodies);
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
          grew += this.#rewrite(doc, facts.mode, item.text, item.size, unique, editor, context.now);
          notices.push({ mode: facts.mode, doc: { ...doc } });
        }
        const hash = requestHash(request);
        this.#record(plan, caller, hash, "bulk_replaced", input.collection, context.now, {
          replaced: docs.length,
        });
        return { value: { replaced: docs.length }, documents: docs.length, declared: false, grew };
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
        const mode = this.#collectionMode(collection);
        let removed = 0;
        for (const id of ids) {
          // Every target was authorized by `planMutation`; one refused target refused them all.
          const doc = this.#document(collection, id) as Doc;
          const seq = this.#deleteDoc(doc, mode);
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
        if (!this.#barred(author)) {
          this.#exec(
            "INSERT INTO pf_barriers (author, at, complete) VALUES (?, ?, 0)",
            author,
            context.now,
          );
          for (const socket of this.sockets.values()) {
            if (socket.attachment.author === author) this.#close(socket, 4410);
          }
          this.#exec("DELETE FROM pf_seq WHERE scope = ?", `author:${author}`);
        }
        const modes = new Map<string, CollectionMode>();
        const modeOf = (name: string) => {
          let mode = modes.get(name);
          if (mode === undefined) {
            mode = this.#collectionMode(name);
            modes.set(name, mode);
          }
          return mode;
        };
        const created = this.#exec(
          `SELECT ${DOC_COLUMNS} FROM pf_documents WHERE author = ? ORDER BY collection, id LIMIT ?`,
          author,
          take,
        ).map(docOf);
        for (const doc of created) {
          const mode = modeOf(doc.collection);
          const seq = this.#deleteDoc(doc, mode);
          notices.push({ mode, doc: { ...doc, seq }, kind: "deleted" });
        }
        const edited = this.#exec(
          `SELECT ${DOC_COLUMNS} FROM pf_documents WHERE editor = ? ORDER BY collection, id LIMIT ?`,
          author,
          take,
        ).map(docOf);
        for (const doc of edited) {
          const mode = modeOf(doc.collection);
          doc.editor = ERASED_EDITOR;
          doc.seq = this.#advance(sequenceScope(mode, doc.collection, doc.author));
          this.#exec(
            "UPDATE pf_documents SET editor = ?, seq = ? WHERE collection = ? AND id = ?",
            ERASED_EDITOR,
            doc.seq,
            doc.collection,
            doc.id,
          );
          notices.push({ mode, doc: { ...doc }, kind: "updated" });
        }
        const operations = this.#deleteFound(
          "pf_ops",
          ["key"],
          this.#exec("SELECT key FROM pf_ops WHERE actor = ? ORDER BY key LIMIT ?", author, take),
        ).length;
        const rates = this.#deleteFound(
          "pf_rates",
          ["subject", "kind", "window"],
          this.#exec(
            "SELECT subject, kind, window FROM pf_rates WHERE subject = ? ORDER BY kind, window LIMIT ?",
            author,
            take,
          ),
        ).length;
        const rights = this.#deleteFound(
          "pf_rights",
          ["author", "day"],
          this.#exec(
            "SELECT author, day FROM pf_rights WHERE author = ? ORDER BY day LIMIT ?",
            author,
            take,
          ),
        ).length;
        let more = chunkLeavesMore(
          { documents: created.length, edits: edited.length, operations, rates, rights },
          take,
        );
        if (!more) {
          const left = (query: string) => this.#exec(query, author).length;
          more = !completes({
            created: left("SELECT 1 FROM pf_documents WHERE author = ? LIMIT 1"),
            edited: left("SELECT 1 FROM pf_documents WHERE editor = ? LIMIT 1"),
            rights: left("SELECT 1 FROM pf_rights WHERE author = ? LIMIT 1"),
          });
          if (!more) {
            this.#exec("DELETE FROM pf_seq WHERE scope = ?", `author:${author}`);
            this.#exec("DELETE FROM pf_author_counts WHERE author = ?", author);
            this.#exec("UPDATE pf_barriers SET complete = 1 WHERE author = ?", author);
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
    return this.#running(context.now, () => {
      const answer = this.#answer(() => {
        const limits = this.#limitsRefusal(context.limits);
        if (limits !== null) fail(limits);
        return this.#transaction(() => {
          const plan = planRead({
            stored: this.#readControl(),
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
      });
      this.#meterUncharged(!answer.ok, context.now, kind);
      return { ...answer, storage: this.#storageReport() } as Answer<T>;
    });
  }

  /**
   * The alarm's flush, through the same metering as everything else: an earlier day's reads into
   * that day, today's into today's row with deferred usage; deferred usage alone stays pending.
   */
  flushReads(now: number): void {
    this.#running(now, () =>
      this.#keeping(() => {
        const control = this.#readControl();
        const result = flushPending({
          pending: this.pending,
          day: (day) => this.#dayRow(day),
          bound: control !== null,
          now,
        });
        if (result.days.length > 0) {
          this.#transaction(() => {
            for (const day of result.days) this.#writeDay(day);
            this.#setControl(touched(control as DataControl, false));
          });
          this.meters.counterWrites += result.days.length;
        }
        this.pending = result.pending;
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
      const [row] = this.#read("SELECT mode FROM pf_collections WHERE name = ?", collection);
      if (row === undefined) return missing();
      const scope = readScope(str(row.mode) as CollectionMode, caller);
      if (scope === "none") return missing();
      const doc = this.#document(collection, id);
      if (doc === null) return missing();
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
        const [row] = this.#read(
          "SELECT mode FROM pf_collections WHERE name = ?",
          query.collection,
        );
        if (row === undefined) return fail({ code: "not_found", message: "no such collection" });
        const ready = this.#fieldsOf(query.collection)
          .filter((field) => field.state === "ready")
          .map((field) => field.field);
        const planned = planQuery(query, str(row.mode) as CollectionMode, caller, ready);
        if (!planned.ok) fail(planned);
        const plan = planned.value;
        if (plan.kind === "empty") return { documents: [], next: null };
        const rows = this.#exec(...querySql(plan)).map(docOf);
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
        const [row] = this.#read(
          "SELECT documents FROM pf_collections WHERE name = ?",
          count.collection,
        );
        if (row === undefined) return fail({ code: "not_found", message: "no such collection" });
        const ready = this.#fieldsOf(count.collection)
          .filter((field) => field.state === "ready")
          .map((field) => field.field);
        const planned = planCount(count, caller, ready);
        if (!planned.ok) fail(planned);
        const plan = planned.value;
        if (plan.kind === "collection") return { documents: num(row.documents) };
        const [found] =
          plan.kind === "author"
            ? this.#exec(
                "SELECT count FROM pf_author_counts WHERE collection = ? AND author = ?",
                count.collection,
                plan.author,
              )
            : this.#exec(
                "SELECT count FROM pf_value_counts WHERE collection = ? AND field = ? AND value = ?",
                count.collection,
                plan.field,
                plan.value,
              );
        return { documents: num(found?.count) };
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
      // Declaration order, sorted here: a sort in SQL reads every row twice.
      const fields = byPosition(
        this.#read("SELECT collection, field, state, cursor, position FROM pf_fields"),
      ).map(fieldOf);
      const collections = byPosition(
        this.#read("SELECT name, mode, unique_key, documents, bytes, position FROM pf_collections"),
      ).map((row) =>
        describeCollection(
          str(row.name),
          {
            mode: str(row.mode) as CollectionMode,
            uniqueKey: optional(row.unique_key),
            documents: num(row.documents),
            bytes: num(row.bytes),
          },
          fields,
        ),
      );
      const control = this.#readControl() as DataControl;
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
    return this.#running(context.now, () => {
      const now = context.now;
      let charged = false;
      const answer = this.#answer(() =>
        this.#transaction(() => {
          const limits = this.#limitsRefusal(context.limits);
          if (limits !== null) fail(limits);
          const plan = planExport({
            stored: this.#readControl(),
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
          const limit = Math.min(take, ARTIFACT_DATA.caps.exportRows) + 1;
          const start = after ?? { collection: "", id: "" };
          const rows =
            author === null
              ? this.#exec(
                  `SELECT ${DOC_COLUMNS} FROM pf_documents WHERE (collection, id) > (?, ?)
                   ORDER BY collection, id LIMIT ?`,
                  start.collection,
                  start.id,
                  limit,
                )
              : this.#exec(
                  `SELECT ${DOC_COLUMNS} FROM pf_documents INDEXED BY pf_documents_creator
                   WHERE author = ? AND (collection, id) > (?, ?) ORDER BY collection, id LIMIT ?`,
                  author,
                  start.collection,
                  start.id,
                  limit,
                );
          const candidates: ExportDocument[] = rows.map(docOf).map((doc) => ({
            collection: doc.collection,
            id: doc.id,
            by: doc.author,
            editedBy: doc.editor,
            created: doc.created,
            updated: doc.updated,
            body: doc.body,
          }));
          const control = this.#readControl() as DataControl;
          const page = cutPage(candidates, take, control.payloadRevision);
          this.#setControl(touched(control, false));
          charged = true;
          this.#charge("export_page", plan.charge, now, false, author, "export_page");
          return page;
        }),
      );
      if (!charged || !answer.ok) this.#meterUncharged(!answer.ok, now, "export_page");
      return { ...answer, storage: this.#storageReport() } as Answer<ExportPage>;
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
      return this.#running(context.now, () =>
        this.#answer(() => fail({ code: "forbidden", message: "owner side only" })),
      );
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
      return this.#running(context.now, () =>
        this.#answer(() => fail({ code: "forbidden", message: "a grant holder's own export" })),
      );
    }
    const take = ARTIFACT_DATA.caps.exportRows;
    return this.#exportCommand(envelope, "visitor", caller.author, after, take, context);
  }

  // Lifecycle: protected work, measured and never refused for budget.

  #controlCommand<T>(
    now: number,
    kind: string,
    work: () => { value: T; wrote: boolean },
  ): Answer<T> {
    return this.#running(now, () => {
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
      return { ...answer, storage: this.#storageReport() } as Answer<T>;
    });
  }

  fence(
    envelope: DataEnvelope,
    fence: DataFence,
    now: number,
  ): Answer<{ epoch: number; held: boolean; ownerId: string }> {
    return this.#controlCommand(now, "fence", () => {
      const applied = applyFence(this.#readControl(), envelope, fence, now);
      if (!applied.ok) fail(applied);
      const { control, repeated, cancelledErase, closeConnections } = applied.value;
      if (!repeated) {
        this.#setControl(control);
        if (cancelledErase !== null) this.#endIntent(cancelledErase, "cancelled", now);
        if (closeConnections) this.closeAll(4003);
      }
      return {
        value: { epoch: control.epoch, held: control.hold !== null, ownerId: control.ownerId },
        wrote: !repeated,
      };
    });
  }

  quarantine(envelope: DataEnvelope, reason: QuarantineReason, now: number): Answer<boolean> {
    return this.#controlCommand(now, "quarantine", () => {
      const decided = quarantine(this.#readControl(), envelope, reason, now);
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
    return this.#controlCommand(now, "resolve_quarantine", () => {
      const decided = resolveQuarantine(this.#readControl(), envelope, decision);
      if (!decided.ok) fail(decided);
      if (decided.value.erasePayload) this.#erasePayload();
      if (decided.value.endedErase !== null) {
        this.#endIntent(decided.value.endedErase, "committed", now);
      }
      this.#setControl(decided.value.control);
      return { value: null, wrote: true };
    });
  }

  #endIntent(id: string, outcome: "committed" | "cancelled", now: number): void {
    this.#exec(
      `INSERT INTO pf_ended (id, outcome, at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET outcome = excluded.outcome, at = excluded.at`,
      id,
      outcome,
      now,
    );
  }

  /**
   * Deletes every payload table, each row measured: the work grows with the data. Never
   * `deleteAll()`, which would also clear the control tables and the alarm: barriers, day
   * counters, rights rows, rate rows, audit obligations, ended intents and the control record stay,
   * and the control record's next generation is written in the same transaction by the caller.
   */
  #erasePayload(): void {
    for (const table of PAYLOAD_TABLES) this.#exec(`DELETE FROM ${table}`);
    this.closeAll(4003);
  }

  #eraseStep(
    step: "prepare" | "commit" | "cancel",
    envelope: DataEnvelope,
    eraseId: string,
    now: number,
  ) {
    return this.#controlCommand(now, `erase_${step}`, () => {
      const [found] = this.#read("SELECT outcome FROM pf_ended WHERE id = ?", eraseId);
      const ended = found === undefined ? null : (str(found.outcome) as "committed" | "cancelled");
      const stored = this.#readControl();
      const decided =
        step === "prepare"
          ? prepareErase(stored, envelope, eraseId, ended, now, this.#dayRow(dayOf(now)).intents)
          : step === "commit"
            ? commitErase(stored, envelope, eraseId, ended)
            : cancelErase(stored, envelope, eraseId, ended);
      if (!decided.ok) fail(decided);
      const result = decided.value;
      if (result.erasePayload) this.#erasePayload();
      if (result.ended !== null) this.#endIntent(result.ended.id, result.ended.outcome, now);
      if (result.control !== null) this.#setControl(result.control);
      if (result.startsIntent) {
        const day = this.#dayRow(dayOf(now));
        this.#writeDay({ ...day, intents: day.intents + 1 });
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
    const answer = this.#controlCommand(now, "settle", () => {
      const stored = this.#readControl();
      const verdict = admit(stored, envelope, { kind: "maintenance" });
      if (!verdict.ok) {
        return { value: { state: "refused" as const, code: verdict.code }, wrote: false };
      }
      const key = operationKey(actor, envelope.generation, opId);
      const [obligation] = this.#read(
        "SELECT kind, detail, state FROM pf_audit WHERE key = ?",
        key,
      );
      const [record] = this.#read("SELECT state, kind FROM pf_ops WHERE key = ?", key);
      const decided = settleDecision(
        {
          obligation:
            obligation === undefined
              ? null
              : {
                  kind: str(obligation.kind),
                  detail: JSON.parse(str(obligation.detail)) as Record<string, number | boolean>,
                  state: str(obligation.state) as "pending" | "delivered",
                },
          record:
            record === undefined
              ? null
              : { state: str(record.state) as "committed" | "aborted", kind: str(record.kind) },
          barred: this.#barred(actor),
          currentGeneration: stored === null || stored.generation === envelope.generation,
        },
        opId,
        now,
      );
      if (decided.writeAborted) {
        this.#setControl(touched(stored ?? newControl(envelope, now), false));
        this.#exec(
          `INSERT INTO pf_ops (key, actor, request_hash, state, kind, target, result, at)
           VALUES (?, ?, '', 'aborted', 'aborted', '', NULL, ?)`,
          key,
          actor,
          now,
        );
      }
      return { value: decided.answer, wrote: decided.writeAborted };
    });
    return (answer as { value: SettleDecision["answer"] }).value;
  }

  acknowledge(envelope: DataEnvelope, actor: string, opId: string, now: number): boolean {
    const answer = this.#controlCommand(now, "acknowledge", () => {
      const stored = this.#readControl();
      if (stored === null || !admit(stored, envelope, { kind: "maintenance" }).ok) {
        return { value: false, wrote: false };
      }
      const key = operationKey(actor, envelope.generation, opId);
      const updated = this.#exec(
        "UPDATE pf_audit SET state = 'delivered', at = ? WHERE key = ? AND state = 'pending' RETURNING key",
        now,
        key,
      );
      if (updated.length === 0) return { value: false, wrote: false };
      this.#setControl(touched(stored, false));
      return { value: true, wrote: true };
    });
    return (answer as { value: boolean }).value;
  }

  // Housekeeping.

  /**
   * One alarm: closes expired connections, prunes a bounded pass of everything due through each
   * class's age index, flushes pending usage and re-arms. It re-admits like any command: it reads
   * the control record in its own transaction, so a hold that landed after the alarm was set
   * prunes nothing. Its work is idempotent, so a late, repeated or retried alarm is harmless.
   */
  alarm(now: number): { pruned: number } {
    return this.#running(now, () => {
      for (const socket of this.sockets.values()) {
        if (socket.closed === null && socket.attachment.deadline <= now) this.#close(socket, 4001);
      }
      let pruned = 0;
      let more = false;
      this.#cost = { rowsRead: 0, rowsWritten: 0 };
      this.#transaction(() => {
        if (pruneAllowed(this.#readControl())) {
          const cut = pruneCutoffs(now);
          const cap = ARTIFACT_DATA.caps.pruneRows;
          const prune = (
            table: string,
            keys: string[],
            age: string,
            extra: string,
            before: number,
          ) =>
            this.#deleteFound(
              table,
              keys,
              this.#exec(
                `SELECT ${[...new Set([...keys, ...(table === "pf_days" ? ACCOUNTED : [])])].join(", ")}
                 FROM ${table} WHERE ${extra}${age} < ? ORDER BY ${age} LIMIT ?`,
                before,
                cap,
              ),
            );
          const classes: Record<RetainedClass, () => number> = {
            operations: () => prune("pf_ops", ["key"], "at", "", cut.operationsBefore).length,
            ended: () => prune("pf_ended", ["id"], "at", "", cut.operationsBefore).length,
            delivered: () =>
              prune("pf_audit", ["key"], "at", "state = 'delivered' AND ", cut.deliveredBefore)
                .length,
            rates: () =>
              prune("pf_rates", ["subject", "kind", "window"], "window", "", cut.rateWindowBefore)
                .length,
            days: () => {
              const rows = prune("pf_days", ["day"], "day", "", cut.dayBefore);
              for (const row of rows) {
                for (const field of ACCOUNTED) this.meters.retired += num(row[field]);
              }
              return rows.length;
            },
            rights: () => prune("pf_rights", ["author", "day"], "day", "", cut.dayBefore).length,
          };
          const counts = RETAINED_CLASSES.map((name) => classes[name]());
          pruned = counts.reduce((sum, n) => sum + n, 0);
          more = passLeftMore(counts);
          if (pruned > 0) this.#setControl(touched(this.#readControl() as DataControl, false));
        }
        // Every pass is metered, an empty one's probes included: deferred, never a day row.
        this.#meter({ kind: "housekeeping" }, now, "prune");
      });
      this.flushReads(now);
      this.#more = more;
      return { pruned };
    });
  }

  // Live.

  #attach(socket: LiveSocket, attachment: LiveAttachment): void {
    const text = JSON.stringify(attachment);
    if (new TextEncoder().encode(text).length > ATTACHMENT_BYTES) {
      throw new Error("a socket's attachment passed its size");
    }
    socket.attachment = attachment;
    socket.port.serializeAttachment(attachment);
  }

  #close(socket: LiveSocket, code: number): void {
    if (socket.closed !== null) return;
    socket.closed = code;
    try {
      socket.port.close(code);
    } catch {
      // Already closed by the other side: nothing to send.
    }
  }

  closeAll(code: number): void {
    for (const socket of this.sockets.values()) this.#close(socket, code);
  }

  /** The other side closed: the connection is gone. */
  closed(socketId: string, code: number): void {
    const socket = this.sockets.get(socketId);
    if (socket !== undefined && socket.closed === null) socket.closed = code;
  }

  connect(
    envelope: DataEnvelope,
    author: string | null,
    principal: string,
    deadline: number,
    context: Context,
  ): Answer<string> {
    return this.#running(context.now, () => {
      const now = context.now;
      let charged = false;
      let full = false;
      const rate = { subject: author ?? "readers", kind: "connects", window: minuteOf(now) };
      const answer = this.#answer(() =>
        this.#transaction(() => {
          const limits = this.#limitsRefusal(context.limits);
          if (limits !== null) fail(limits);
          const fileBefore = this.fileBytes();
          const stored = this.#readControl();
          const open = [...this.sockets.values()].filter((socket) => socket.closed === null);
          const [connects] = this.#read(
            "SELECT count FROM pf_rates WHERE subject = ? AND kind = ? AND window = ?",
            rate.subject,
            rate.kind,
            rate.window,
          );
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
            connectsThisMinute: num(connects?.count),
          });
          if (refused !== null) fail(refused);
          this.#countRate(rate);
          const control = stored as DataControl;
          this.#setControl(touched(control, false));
          const socketId = this.#ids();
          const attachment = newAttachment({
            socketId,
            author,
            principal,
            generation: control.generation,
            liveEpoch: control.liveEpoch,
            deadline,
            now,
            limits: context.limits,
          });
          charged = true;
          this.#charge("connect", "growth", now, false);
          // A connect is growth: its rate row and counters are judged against the measured file
          // like any growing mutation, after the charge and before the socket is accepted.
          const refusal = growthRefusal(
            { dataBytes: 0, fileBefore, fileAfter: this.fileBytes(), grew: 0 },
            context.limits,
          );
          if (refusal !== null) {
            full = true;
            fail(refusal);
          }
          const socket: LiveSocket = { port: this.#accept(socketId), attachment, closed: null };
          this.#attach(socket, attachment);
          this.sockets.set(socketId, socket);
          return socketId;
        }),
      );
      if (full) {
        // Rolled back whole; the work it did is charged to growth with its attempt, as a
        // mutation's failed work is.
        this.#transaction(() => {
          this.#countRate(rate);
          this.#setControl(touched(this.#readControl() as DataControl, false));
          this.#charge("connect", "growth", now, true);
        });
      } else if (!charged || !answer.ok) {
        this.#meterUncharged(true, now, null);
      }
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
    return this.#running(context.now, () =>
      this.#uncharged(
        context.now,
        () => {
          if (!admit(this.#readControl(), envelope, { kind: "request", create: false }).ok) {
            return false;
          }
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
          this.#attach(socket, decided.attachment);
          return true;
        },
        (ok) => !ok,
      ),
    );
  }

  #live(socket: LiveSocket, now: number): LiveAttachment | null {
    if (socket.closed !== null) return null;
    const author = socket.attachment.author;
    const checked = liveCheck(
      this.#readControl(),
      socket.attachment,
      author !== null && this.#barred(author),
      now,
    );
    if ("close" in checked) {
      this.#close(socket, checked.close);
      return null;
    }
    return checked.attachment;
  }

  /**
   * Sends one message, reserving against today first when nothing is reserved today. The
   * reservation is durable (its own transaction) before the message goes out.
   */
  #send(socket: LiveSocket, attachment: LiveAttachment, text: string, now: number): void {
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
          this.#writeDay({ ...day, live: day.live + granted });
          this.#setControl(touched(this.#readControl() as DataControl, false));
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
    this.#attach(socket, decided.attachment);
    socket.port.send(text);
  }

  message(socketId: string, text: string, now: number): void {
    this.#running(now, () => this.#uncharged(now, () => this.#message(socketId, text, now)));
  }

  #message(socketId: string, text: string, now: number): void {
    const socket = this.sockets.get(socketId);
    if (socket === undefined) return;
    const current = this.#live(socket, now);
    if (current === null) return;
    const received = inbound(current, new TextEncoder().encode(text).length);
    if ("close" in received) {
      this.#close(socket, received.close);
      return;
    }
    this.#attach(socket, received.attachment);
    let name = "";
    try {
      name = String((JSON.parse(text) as { subscribe?: unknown }).subscribe);
    } catch {
      name = "";
    }
    const [row] = this.#read("SELECT mode FROM pf_collections WHERE name = ?", name);
    const caller: Caller =
      current.author === null
        ? { kind: "reader" }
        : { kind: "visitor", author: current.author, canWrite: false };
    if (row === undefined || readScope(str(row.mode) as CollectionMode, caller) === "none") {
      this.#send(socket, received.attachment, JSON.stringify({ error: "not_found" }), now);
      return;
    }
    this.#send(
      socket,
      subscribed(received.attachment, name),
      JSON.stringify({ subscribed: name }),
      now,
    );
  }

  #notify(
    mode: CollectionMode,
    doc: Doc,
    kind: "created" | "updated" | "deleted",
    now: number,
  ): void {
    if (this.sockets.size === 0) return;
    const text = JSON.stringify({
      collection: doc.collection,
      kind,
      id: doc.id,
      seq: doc.seq,
      by: doc.author,
    });
    this.#uncharged(now, () => {
      for (const socket of this.sockets.values()) {
        const attachment = this.#live(socket, now);
        if (attachment === null || !receives(attachment, doc.collection, mode, doc.author)) {
          continue;
        }
        this.#send(socket, attachment, text, now);
      }
    });
  }

  // Inspection: plain reads outside metering, for tests and diagnostics, never from a command.

  /** Every row of one of the object's tables. */
  inspect(table: string): Row[] {
    if (!/^pf_[a-z_]+$/.test(table)) throw new Error("not a documents table");
    try {
      return this.#sql.exec(`SELECT * FROM ${table}`).toArray() as Row[];
    } catch (error) {
      if (String(error).includes("no such table")) return [];
      throw error;
    }
  }

  /** The rows the day counters, the pending usage and retired rows account for. */
  accounted(): number {
    let sum = this.meters.retired + this.pending.rows + this.pending.deferred;
    for (const row of this.inspect("pf_days")) {
      for (const field of ACCOUNTED) sum += num(row[field]);
    }
    return sum;
  }
}

/** Rows in declaration order. */
function byPosition(rows: Row[]): Row[] {
  return rows.sort((a, b) => num(a.position) - num(b.position));
}

type SeekPlan = Extract<QueryPlan, { kind: "seek" }>;

/**
 * The statement of a planned query, matching `planMatches`: a seek through the plan's index bound
 * by every column before `created`, an optional range on `created`, the cursor as a row value, the
 * order and the page plus one. The tests assert each shape's query plan.
 */
export function querySql(plan: SeekPlan): [string, ...SqlStorageValue[]] {
  const binds: SqlStorageValue[] = [];
  const where: string[] = [];
  const direction = plan.descending ? "DESC" : "ASC";
  const cursorOp = plan.descending ? "<" : ">";
  const rangeOps = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
  const prefix = plan.index === "values" ? "v." : "";
  if (plan.index === "values") {
    where.push("v.collection = ?", "v.field = ?", "v.value = ?");
    binds.push(plan.collection, plan.field, plan.value);
  } else {
    where.push("collection = ?");
    binds.push(plan.collection);
    if (plan.index === "author") {
      where.push("author = ?");
      binds.push(plan.author);
    }
  }
  if (plan.range !== null) {
    where.push(`${prefix}created ${rangeOps[plan.range.op]} ?`);
    binds.push(plan.range.value);
  }
  if (plan.after !== null) {
    where.push(`(${prefix}created, ${prefix}id) ${cursorOp} (?, ?)`);
    binds.push(plan.after[0], plan.after[1]);
  }
  binds.push(plan.fetch);
  const order = `ORDER BY ${prefix}created ${direction}, ${prefix}id ${direction} LIMIT ?`;
  if (plan.index === "values") {
    const columns = DOC_COLUMNS.split(", ")
      .map((column) => `d.${column}`)
      .join(", ");
    return [
      `SELECT ${columns} FROM pf_values v JOIN pf_documents d ON d.collection = v.collection AND d.id = v.id
       WHERE ${where.join(" AND ")} ${order}`,
      ...binds,
    ];
  }
  const index = plan.index === "author" ? "pf_documents_author" : "pf_documents_created";
  return [
    `SELECT ${DOC_COLUMNS} FROM pf_documents INDEXED BY ${index} WHERE ${where.join(" AND ")} ${order}`,
    ...binds,
  ];
}
