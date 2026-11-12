// An in-memory documents object for the artifact data protocols' tests (decision 0026, delivery
// 3): the thin shell delivery 4 builds over SQLite, here over maps. Every command reads state,
// calls the domain's decisions and writes their result in one transaction (a snapshot restored on
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
  flushed,
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
  noPendingReads,
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
  withinBound,
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
type Proceed = Extract<MutationPlan, { decision: "proceed" }>;

const key2 = (...parts: (string | number)[]) => parts.join("\u0000");
const ACCOUNTED = ["growth", "read", "cleanup", "export", "rights", "protected"] as const;

export class MemoryObject {
  durable: Durable = emptyDurable();
  pending: PendingReads = noPendingReads(0);
  /** Each caller's attempts in the current minute, in memory (one minute is kept). */
  attempts = new Map<string, number>();
  sockets = new Map<string, Socket>();
  charges: ChargeEntry[] = [];
  /** Operations whose measured rows passed their stated bound (`withinBound`). */
  exceeded: { kind: OperationKind; cost: Cost }[] = [];
  faults: Faults = {};
  /** The independent oracle: every row accessed, never reset, read by no charge. */
  accesses = 0;
  /** Accounted rows that left the day counters: pruned day rows and pending lost to eviction. */
  retired = 0;
  #cost: Cost = { rowsRead: 0, rowsWritten: 0 };
  #ids = 0;

  constructor(readonly name = "obj") {}

  // Primitive accesses, each counted as a row.

  #read<T>(value: T): T {
    this.#cost.rowsRead += 1;
    this.accesses += 1;
    return value;
  }

  #wrote(rows = 1): void {
    this.#cost.rowsWritten += rows;
    this.accesses += rows;
  }

  #newId(): string {
    this.#ids += 1;
    return `${this.name}${this.#ids}`.padStart(16, "x").slice(-16);
  }

  /** A transaction: a snapshot of storage restored when the function throws. */
  #transaction<T>(work: () => T): T {
    const snapshot = structuredClone(this.durable);
    try {
      return work();
    } catch (error) {
      this.durable = snapshot;
      throw error;
    }
  }

  #storage(): StorageReport {
    const control = this.durable.control;
    return {
      generation: control?.generation ?? 0,
      seq: control?.storageSeq ?? 0,
      bytes: this.fileBytes(),
    };
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
      d.rights.size;
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
  #meter(terminal: Terminal, now: number, kind: OperationKind | null): DayCounters | null {
    const cost = { ...this.#cost };
    if (kind !== null && !withinBound(kind, cost)) this.exceeded.push({ kind, cost });
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
    if (result.rights !== null) {
      this.durable.rights.set(key2(result.rights.author, dayOf(now)), result.rights.used);
    }
    this.pending = result.pending;
    if (terminal.kind === "uncharged" && result.days.length > 0 && control !== null) {
      this.durable.control = touched(control, false);
    }
    this.#rearm(now);
    return result.days.at(-1) ?? null;
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
    const usedBefore = author === null ? this.#used(charge, now) : this.#rightsUsed(author, now);
    const folded = charge === "protected" ? this.pending.deferred : 0;
    const cost = { ...this.#cost };
    const day = this.#meter({ kind: "charged", charge, author }, now, bound) as DayCounters;
    const dayAfter = author === null ? day[charge] : this.#rightsUsed(author, now);
    this.charges.push({ kind, charge, cost, usedBefore, dayAfter, folded, failed });
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
    this.#wrote();
    this.durable.control = control;
  }

  #barred(author: string): boolean {
    return this.#read(this.durable.barriers.has(author));
  }

  #facts(name: string): CollectionFacts | null {
    const collection = this.#read(this.durable.collections.get(name));
    if (collection === undefined) return null;
    return { ...collection, fields: declaredFields(this.durable.fields, name) };
  }

  #reads(now: number, actor: MutationActor): MutationReads {
    let attempts: number | null = null;
    return {
      prior: (key) => this.#read(this.durable.ops.get(key)) ?? null,
      barred: (author) => this.#barred(author),
      collection: (name) => this.#facts(name),
      document: (collection, id) => {
        const doc = this.#read(this.durable.documents.get(key2(collection, id)));
        return doc === undefined ? null : { creator: doc.author, size: doc.size };
      },
      documentsSize: (collection, ids) => {
        let size = 0;
        for (const id of ids) {
          const doc = this.#read(this.durable.documents.get(key2(collection, id)));
          if (doc === undefined) return null;
          size += doc.size;
        }
        return size;
      },
      used: (charge) => this.#read(this.#used(charge, now)),
      rights: (author) => this.#read(this.#rightsUsed(author, now)),
      callerAttempts: () => {
        attempts ??= this.#attempt(actor, now);
        return attempts;
      },
      rate: (subject, kind, window) =>
        this.#read(this.durable.rates.get(key2(subject, kind, window)) ?? 0),
    };
  }

  #rearm(now: number, more = false): void {
    const d = this.durable;
    const min = (values: Iterable<number>) => {
      let best: number | null = null;
      for (const value of values) best = best === null || value < best ? value : best;
      return best;
    };
    const deadlines = [...this.sockets.values()]
      .filter((socket) => socket.closed === null)
      .map((socket) => socket.attachment.deadline);
    d.alarm = nextAlarm({
      control: d.control,
      deadlines,
      oldest: {
        operation: min([...d.ops.values(), ...d.ended.values()].map((row) => row.at)),
        delivered: min(
          [...d.audit.values()].filter((row) => row.state === "delivered").map((row) => row.at),
        ),
        rateWindow: min([...d.rates.keys()].map((key) => Number(key.split("\u0000")[2]))),
        day: min([
          ...d.days.keys(),
          ...[...d.rights.keys()].map((key) => Number(key.split("\u0000")[1])),
        ]),
      },
      more,
      pendingFlushAt: d.control === null ? null : pendingDeadline(this.pending),
      now,
    });
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
    let plan: MutationPlan | null = null;
    const now = context.now;
    const answer = this.#answer(() => {
      try {
        return this.#transaction(() => {
          plan = planMutation(
            this.#read(this.durable.control),
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
          const audit = auditObligation(kind, actor, done.detail ?? { documents: done.documents });
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
            this.#charge(kind, proceeded.charge, now, true, proceeded.rightsAuthor);
          });
        } else {
          this.#meterUncharged(true, now, kind);
        }
        throw error;
      }
    });
    if (answer.ok && "replayed" in answer) {
      this.#meterUncharged(false, now, kind);
      return { ...answer, storage: this.#storage() };
    }
    if (answer.ok) after?.(answer.value);
    return answer;
  }

  #countRate(rate: { subject: string; kind: string; window: number }): void {
    const key = key2(rate.subject, rate.kind, rate.window);
    this.#wrote();
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
    this.#wrote();
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
    this.#wrote();
    this.durable.audit.set(plan.key, { ...obligation, owner, state: "pending", at: now });
  }

  #advance(scope: string): number {
    if (!sequenceAdvances(scope, (author) => this.#barred(author))) return 0;
    const value = (this.durable.seq.get(scope) ?? 0) + 1;
    this.#wrote();
    this.durable.seq.set(scope, value);
    return value;
  }

  #countValues(collection: string, deltas: { field: string; value: string; delta: number }[]) {
    for (const { field, value, delta } of deltas) {
      const key = key2(collection, field, value);
      this.#wrote();
      this.durable.valueCounts.set(key, (this.durable.valueCounts.get(key) ?? 0) + delta);
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
      this.#wrote();
      doc.values[entry.field] = entry.value;
    }
  }

  #countAuthor(collection: string, author: string, delta: number): void {
    const key = key2(collection, author);
    this.#wrote();
    this.durable.authorCounts.set(key, (this.durable.authorCounts.get(key) ?? 0) + delta);
  }

  #deleteDoc(doc: Doc): number {
    const d = this.durable;
    d.documents.delete(key2(doc.collection, doc.id));
    this.#wrote(1 + Object.keys(doc.values).length);
    this.#countValues(
      doc.collection,
      valueCountDeltas(
        Object.entries(doc.values).map(([field, value]) => ({ field, value })),
        [],
      ),
    );
    this.#countAuthor(doc.collection, doc.author, -1);
    const collection = d.collections.get(doc.collection) as Collection;
    collection.documents -= 1;
    collection.bytes -= doc.size;
    this.#wrote();
    return this.#advance(sequenceScope(collection.mode, doc.collection, doc.author));
  }

  #indexStep(): number {
    const field = nextBuild(this.durable.fields);
    if (field !== null) {
      const covered = [...this.durable.documents.values()]
        .filter(
          (doc) =>
            doc.collection === field.collection && (field.cursor === null || doc.id > field.cursor),
        )
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, ARTIFACT_DATA.caps.indexStepDocuments);
      for (const doc of covered) {
        this.#read(doc);
        if (doc.values[field.field] !== undefined) continue;
        const body = JSON.parse(doc.body) as Record<string, unknown>;
        const entries = indexEntries(body, [field.field]);
        this.#countValues(doc.collection, valueCountDeltas([], entries));
        for (const entry of entries) {
          this.#wrote();
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
      this.#wrote();
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
    this.#read(unique);
    for (const doc of this.durable.documents.values()) {
      if (
        doc.collection === collection &&
        doc.author === author &&
        doc.unique === unique &&
        doc.id !== except
      ) {
        fail({ code: "conflict", message: "already exists" });
      }
    }
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
    this.#wrote();
    this.durable.documents.set(key2(collection, doc.id), doc);
    this.#index(doc);
    this.#countAuthor(collection, author, 1);
    const stored = this.durable.collections.get(collection) as Collection;
    stored.documents += 1;
    stored.bytes += size;
    this.#wrote();
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
    this.#wrote();
    this.#index(doc);
    const stored = this.durable.collections.get(doc.collection) as Collection;
    stored.bytes += size - old;
    this.#wrote();
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
        this.#wrote();
        this.durable.collections.set(declaration.name, {
          mode: declaration.mode,
          uniqueKey: declaration.uniqueKey ?? null,
          documents: 0,
          bytes: 0,
        });
      }
      for (const field of decided.value.addFields) {
        this.#wrote();
        this.durable.fields.push({
          collection: declaration.name,
          field,
          state: "building",
          cursor: null,
        });
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
        const doc = this.durable.documents.get(key2(collection, id)) as Doc;
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
        const docs = ids.map((id) => this.durable.documents.get(key2(input.collection, id)) as Doc);
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
      { collection },
      (plan) => {
        if (ids.length === 0 || ids.length > ARTIFACT_DATA.caps.bulkDocuments) {
          fail({ code: "invalid_input", message: "between 1 and 100 documents" });
        }
        const mode = (this.durable.collections.get(collection) as Collection).mode;
        let removed = 0;
        for (const id of ids) {
          const doc = this.#read(this.durable.documents.get(key2(collection, id)));
          if (doc === undefined) continue;
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
        if (!this.#read(d.barriers.has(author))) {
          this.#wrote();
          d.barriers.set(author, { at: context.now, complete: false });
          for (const socket of this.sockets.values()) {
            if (socket.attachment.author === author) this.#close(socket, 4410);
          }
          if (d.seq.delete(`author:${author}`)) this.#wrote();
        }
        const created = [...d.documents.values()]
          .filter((doc) => doc.author === author)
          .sort((a, b) => (key2(a.collection, a.id) < key2(b.collection, b.id) ? -1 : 1))
          .slice(0, take);
        for (const doc of created) {
          this.#read(doc);
          const mode = (d.collections.get(doc.collection) as Collection).mode;
          const seq = this.#deleteDoc(doc);
          notices.push({ mode, doc: { ...doc, seq }, kind: "deleted" });
        }
        const edited = [...d.documents.values()]
          .filter((doc) => doc.editor === author)
          .slice(0, take);
        for (const doc of edited) {
          this.#read(doc);
          const mode = (d.collections.get(doc.collection) as Collection).mode;
          doc.editor = ERASED_EDITOR;
          doc.seq = this.#advance(sequenceScope(mode, doc.collection, doc.author));
          this.#wrote();
          notices.push({ mode, doc: { ...doc }, kind: "updated" });
        }
        const ops = [...d.ops.entries()].filter(([, row]) => row.actor === author).slice(0, take);
        for (const [key] of ops) d.ops.delete(key);
        this.#wrote(ops.length);
        const rates = [...d.rates.keys()]
          .filter((key) => key.split("\u0000")[0] === author)
          .slice(0, take);
        for (const key of rates) d.rates.delete(key);
        this.#wrote(rates.length);
        let more = chunkLeavesMore(
          {
            documents: created.length,
            edits: edited.length,
            operations: ops.length,
            rates: rates.length,
          },
          take,
        );
        if (!more) {
          const left = {
            created: this.#read([...d.documents.values()].filter((doc) => doc.author === author))
              .length,
            edited: this.#read([...d.documents.values()].filter((doc) => doc.editor === author))
              .length,
          };
          more = !completes(left);
          if (!more) {
            d.seq.delete(`author:${author}`);
            for (const key of [...d.authorCounts.keys()]) {
              if (key.split("\u0000")[1] === author) {
                d.authorCounts.delete(key);
                this.#wrote();
              }
            }
            d.barriers.set(author, {
              at: (d.barriers.get(author) as { at: number }).at,
              complete: true,
            });
            this.#wrote(2);
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
    const answer = this.#answer(() => {
      const plan = planRead({
        stored: this.#read(this.durable.control),
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
  }

  /** Writes all pending usage now (the alarm's flush), an earlier day's into that day. */
  flushReads(now: number): void {
    const control = this.durable.control;
    if (control === null) return;
    const { previous, current } = rollPending(this.pending, now);
    let wrote = false;
    for (const pending of [previous, current]) {
      if (pending === null || (pending.rows === 0 && pending.refused === 0)) continue;
      this.durable.days.set(pending.day, flushed(this.#dayRow(pending.day), pending));
      wrote = true;
    }
    this.pending = wrote ? noPendingReads(now) : current;
    if (wrote) this.durable.control = touched(control, false);
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
      const doc = this.#read(this.durable.documents.get(key2(collection, id)));
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
        const rows = [...this.durable.documents.values()]
          .filter((doc) => doc.collection === query.collection && planMatches(plan, doc))
          .sort((a, b) => {
            const order = a.created === b.created ? (a.id < b.id ? -1 : 1) : a.created - b.created;
            return plan.descending ? -order : order;
          })
          .slice(0, plan.fetch);
        for (const row of rows) this.#read(row);
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
        return { documents: this.#read(map.get(key) ?? 0) };
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
      const collections = [...this.durable.collections.entries()].map(([name, facts]) => {
        this.#read(facts);
        return describeCollection(name, facts, this.durable.fields);
      });
      const control = this.durable.control as DataControl;
      const decided = describe(caller, {
        generation: control.generation,
        revision: control.payloadRevision,
        collections,
        today: this.#read(this.#dayRow(dayOf(context.now))),
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
    const now = context.now;
    let charged = false;
    const answer = this.#answer(() =>
      this.#transaction(() => {
        const plan = planExport({
          stored: this.#read(this.durable.control),
          envelope,
          who,
          limits: context.limits,
          used: (charge) =>
            this.#read(
              author !== null && charge === "rights"
                ? this.#rightsUsed(author, now)
                : this.#used(charge, now),
            ),
          barred: author !== null && this.#barred(author),
        });
        if (plan.decision === "empty") return { rows: [], next: null, revision: 0, bytes: 0 };
        if (plan.decision === "refused") fail(plan.refusal);
        const candidates: ExportDocument[] = [...this.durable.documents.values()]
          .filter((doc) => author === null || doc.author === author)
          .filter((doc) => after === null || keyBefore(after, doc))
          .sort((a, b) => (keyBefore(a, b) ? -1 : 1))
          .slice(0, Math.min(take, ARTIFACT_DATA.caps.exportRows) + 1)
          .map((doc) => ({
            collection: doc.collection,
            id: doc.id,
            by: doc.author,
            editedBy: doc.editor,
            created: doc.created,
            updated: doc.updated,
            body: doc.body,
          }));
        for (const row of candidates) this.#read(row);
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
  }

  fence(
    envelope: DataEnvelope,
    fence: DataFence,
    now: number,
  ): Answer<{ epoch: number; held: boolean; ownerId: string }> {
    return this.#control(now, "fence", () => {
      const applied = applyFence(this.#read(this.durable.control), envelope, fence, now);
      if (!applied.ok) fail(applied);
      const { control, repeated, cancelledErase, closeConnections } = applied.value;
      if (!repeated) {
        this.#setControl(control);
        if (cancelledErase !== null) {
          this.#wrote();
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
      const decided = quarantine(this.#read(this.durable.control), envelope, reason, now);
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
      const decided = resolveQuarantine(this.#read(this.durable.control), envelope, decision);
      if (!decided.ok) fail(decided);
      if (decided.value.erasePayload) this.#erasePayload();
      if (decided.value.endedErase !== null) {
        this.#wrote();
        this.durable.ended.set(decided.value.endedErase, { outcome: "committed", at: now });
      }
      this.#setControl(decided.value.control);
      return { value: null, wrote: true };
    });
  }

  /** Deletes every payload row, each counted: the work grows with the data, as it does in SQL. */
  #erasePayload(): void {
    const d = this.durable;
    let rows = d.collections.size + d.fields.length + d.authorCounts.size + d.valueCounts.size;
    rows += d.seq.size + d.ops.size;
    for (const doc of d.documents.values()) rows += 1 + Object.keys(doc.values).length;
    for (let index = 0; index < rows; index++) this.#read(null);
    this.#wrote(rows);
    const fresh = emptyDurable();
    for (const table of PAYLOAD) {
      (d as unknown as Record<string, unknown>)[table] = fresh[table];
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
      const ended = this.#read(this.durable.ended.get(eraseId)?.outcome ?? null);
      const stored = this.#read(this.durable.control);
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
        this.#wrote();
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
      const stored = this.#read(this.durable.control);
      const verdict = admit(stored, envelope, { kind: "maintenance" });
      if (!verdict.ok) {
        return { value: { state: "refused" as const, code: verdict.code }, wrote: false };
      }
      const key = operationKey(actor, envelope.generation, opId);
      const decided = settleDecision(
        {
          obligation: this.#read(this.durable.audit.get(key)) ?? null,
          record: this.#read(this.durable.ops.get(key)) ?? null,
          barred: this.#barred(actor),
          currentGeneration: stored === null || stored.generation === envelope.generation,
        },
        opId,
        now,
      );
      if (decided.writeAborted) {
        this.#setControl(touched(stored ?? newControl(envelope, now), false));
        this.#wrote();
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
      const stored = this.#read(this.durable.control);
      if (stored === null || !admit(stored, envelope, { kind: "maintenance" }).ok) {
        return { value: false, wrote: false };
      }
      const key = operationKey(actor, envelope.generation, opId);
      const row = this.#read(this.durable.audit.get(key));
      if (row === undefined || row.state !== "pending") return { value: false, wrote: false };
      row.state = "delivered";
      row.at = now;
      this.#wrote();
      this.durable.control = touched(stored, false);
      return { value: true, wrote: true };
    });
    return (answer as { value: boolean }).value;
  }

  // Housekeeping.

  /** One alarm: closes expired connections, prunes a bounded pass of everything due, flushes. */
  alarm(now: number): { pruned: number } {
    for (const socket of this.sockets.values()) {
      if (socket.closed === null && socket.attachment.deadline <= now) this.#close(socket, 4001);
    }
    const d = this.durable;
    let pruned = 0;
    let more = false;
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    if (pruneAllowed(d.control)) {
      this.#transaction(() => {
        const cut = pruneCutoffs(now);
        const cap = ARTIFACT_DATA.caps.pruneRows;
        const take = <K, V>(
          map: Map<K, V>,
          old: (key: K, value: V) => boolean,
          age: (key: K, value: V) => number,
          retire?: (value: V) => void,
        ) => {
          const keys = [...map.entries()]
            .filter(([k, v]) => old(k, v))
            .sort((a, b) => age(a[0], a[1]) - age(b[0], b[1]))
            .slice(0, cap)
            .map(([k]) => k);
          for (const k of keys) {
            this.#read(k);
            this.#wrote();
            retire?.(map.get(k) as V);
            map.delete(k);
          }
          return keys.length;
        };
        const window = (key: string, part: number) => Number(key.split("\u0000")[part]);
        const counts = [
          take(
            d.ops,
            (_k, v) => v.at < cut.operationsBefore,
            (_k, v) => v.at,
          ),
          take(
            d.ended,
            (_k, v) => v.at < cut.operationsBefore,
            (_k, v) => v.at,
          ),
          take(
            d.audit,
            (_k, v) => v.state === "delivered" && v.at < cut.deliveredBefore,
            (_k, v) => v.at,
          ),
          take(
            d.rates,
            (k) => window(k, 2) < cut.rateWindowBefore,
            (k) => window(k, 2),
          ),
          take(
            d.days,
            (k) => k < cut.dayBefore,
            (k) => k,
            (row) => {
              for (const field of ACCOUNTED) this.retired += row[field];
            },
          ),
          take(
            d.rights,
            (k) => window(k, 1) < cut.dayBefore,
            (k) => window(k, 1),
          ),
        ];
        pruned = counts.reduce((sum, n) => sum + n, 0);
        more = passLeftMore(counts);
        if (pruned > 0) {
          this.durable.control = touched(d.control as DataControl, false);
          this.#meter({ kind: "housekeeping" }, now, "prune");
        }
      });
    }
    this.flushReads(now);
    this.#rearm(now, more);
    return { pruned };
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
    const now = context.now;
    let charged = false;
    const answer = this.#answer(() =>
      this.#transaction(() => {
        const stored = this.#read(this.durable.control);
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
          usedGrowth: this.#read(this.#used("growth", now)),
          connectsThisMinute: this.#read(
            this.durable.rates.get(key2(rate.subject, rate.kind, rate.window)) ?? 0,
          ),
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
  }

  renew(
    envelope: DataEnvelope,
    socketId: string,
    principal: string,
    deadline: number,
    context: Context,
  ): boolean {
    if (!admit(this.durable.control, envelope, { kind: "request", create: false }).ok) return false;
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
        const day = this.#read(this.#dayRow(dayOf(now)));
        granted = liveReservation(day.live, attachment.liveMessagesPerDay);
        if (granted > 0) {
          this.#wrote(2);
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
    for (const socket of this.sockets.values()) {
      const attachment = this.#live(socket, now);
      if (attachment === null || !receives(attachment, doc.collection, mode, doc.author)) continue;
      this.#send(socket, attachment, text, now);
    }
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
  };
}

/** Storage without the alarm, which the first pending usage arms: what "writes nothing" compares. */
export function rows(durable: Durable): Omit<Durable, "alarm"> {
  const { alarm: _alarm, ...rest } = structuredClone(durable);
  return rest;
}
