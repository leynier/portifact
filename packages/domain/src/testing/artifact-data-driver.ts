// One interface for the documents objects the artifact data suites drive (decision 0026, delivery
// 4): the in-memory reference (`MemoryObject`, which answers synchronously) and the real Durable
// Object on SQLite in workerd (`apps/data/test/driver.ts`, which answers through
// `runInDurableObject`). Every command answers a value or a promise of it, so a suite awaits every
// call and runs unchanged against either; `view` gives the object's state in the reference's shape
// (`Durable`) with its meters, read from the real tables for the real object.
import type {
  ArtifactDataLimits,
  BulkCreate,
  BulkReplace,
  CollectionDeclaration,
  DataCount,
  DataDescription,
  DataEnvelope,
  DataFence,
  DataQuery,
  DayCounters,
  ExportCursor,
  QuarantineReason,
} from "@portifact/contracts/artifact-data";
import type {
  Caller,
  Cost,
  ExportPage,
  LiveAttachment,
  MutationKind,
  OperationKind,
  PendingReads,
  SettleDecision,
} from "../artifact-data/index.ts";
import type { Answer, AuditRow, ChargeEntry, Durable, OpRecord } from "./artifact-data-object.ts";

export type MaybePromise<T> = T | Promise<T>;

type Context = { now: number; limits: ArtifactDataLimits };

/** One connection as the suites see it: its attachment, what it received and its close code. */
export interface SocketView {
  attachment: LiveAttachment;
  received: string[];
  closed: number | null;
}

/** An object's state and meters, in the reference's shapes. */
export interface ObjectView {
  durable: Durable;
  pending: PendingReads;
  sockets: Map<string, SocketView>;
  charges: ChargeEntry[];
  checked: { kind: OperationKind; cost: Cost; failed: boolean }[];
  /** The oracle: every row the store saw outside bookkeeping, read by no charge. */
  accesses: number;
  counterWrites: number;
  retired: number;
  accounted(): number;
  fileBytes(): number;
}

export interface DriverFaults {
  /** Throws after a mutation's work, before its charge, when it answers true. */
  afterWork?: (kind: MutationKind) => boolean;
}

/**
 * Retained control rows a test puts in place directly (a long-held object released after old
 * records accumulated), keyed as `Durable`'s maps are. Every row is one the object could hold.
 */
export interface SeedRows {
  clear?: ("ops" | "audit" | "days")[];
  ops?: [string, OpRecord][];
  ended?: [string, { outcome: "committed" | "cancelled"; at: number }][];
  audit?: [string, AuditRow][];
  /** `subject \0 kind \0 window`. */
  rates?: [string, number][];
  days?: DayCounters[];
  /** `author \0 day`. */
  rights?: [string, number][];
}

/** The documents object as the suites drive it. */
export interface DataObject {
  /** Which object answers: the in-memory reference or the Durable Object on SQLite. */
  readonly kind: "memory" | "real";
  declare(
    envelope: DataEnvelope,
    caller: Caller,
    declaration: CollectionDeclaration,
    context: Context,
  ): MaybePromise<Answer<{ building: number }>>;
  indexStep(
    envelope: DataEnvelope,
    caller: Caller,
    context: Context,
  ): MaybePromise<Answer<{ building: number }>>;
  create(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    body: unknown,
    context: Context,
  ): MaybePromise<Answer<Record<string, unknown>>>;
  replace(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    id: string,
    body: unknown,
    context: Context,
  ): MaybePromise<Answer<Record<string, unknown>>>;
  remove(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    id: string,
    context: Context,
  ): MaybePromise<Answer<{ id: string }>>;
  bulkCreate(
    envelope: DataEnvelope,
    caller: Caller,
    input: BulkCreate,
    context: Context,
  ): MaybePromise<Answer<{ ids: string[] }>>;
  bulkReplace(
    envelope: DataEnvelope,
    caller: Caller,
    input: BulkReplace,
    context: Context,
  ): MaybePromise<Answer<{ replaced: number }>>;
  bulkRemove(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    ids: string[],
    context: Context,
  ): MaybePromise<Answer<{ removed: number }>>;
  eraseAuthorChunk(
    envelope: DataEnvelope,
    author: string,
    requested: number,
    context: Context,
  ): MaybePromise<Answer<{ documents: number; edits: number; more: boolean }>>;
  get(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    id: string,
    context: Context,
  ): MaybePromise<Answer<Record<string, unknown>>>;
  query(
    envelope: DataEnvelope,
    caller: Caller,
    query: DataQuery,
    context: Context,
  ): MaybePromise<Answer<{ documents: Record<string, unknown>[]; next: string | null }>>;
  count(
    envelope: DataEnvelope,
    caller: Caller,
    count: DataCount,
    context: Context,
  ): MaybePromise<Answer<{ documents: number }>>;
  describe(
    envelope: DataEnvelope,
    caller: Caller,
    context: Context,
  ): MaybePromise<Answer<DataDescription>>;
  exportPage(
    envelope: DataEnvelope,
    caller: Caller,
    after: ExportCursor | null,
    take: number,
    context: Context,
    operator?: boolean,
  ): MaybePromise<Answer<ExportPage>>;
  exportMine(
    envelope: DataEnvelope,
    caller: Caller,
    after: ExportCursor | null,
    context: Context,
  ): MaybePromise<Answer<ExportPage>>;
  fence(
    envelope: DataEnvelope,
    fence: DataFence,
    now: number,
  ): MaybePromise<Answer<{ epoch: number; held: boolean; ownerId: string }>>;
  quarantine(
    envelope: DataEnvelope,
    reason: QuarantineReason,
    now: number,
  ): MaybePromise<Answer<boolean>>;
  resolveQuarantine(
    envelope: DataEnvelope,
    decision: "adopt" | "erase",
    now: number,
  ): MaybePromise<Answer<null>>;
  prepareErase(
    envelope: DataEnvelope,
    eraseId: string,
    now: number,
  ): MaybePromise<Answer<{ outcome: string }>>;
  commitErase(
    envelope: DataEnvelope,
    eraseId: string,
    now: number,
  ): MaybePromise<Answer<{ outcome: string }>>;
  cancelErase(
    envelope: DataEnvelope,
    eraseId: string,
    now: number,
  ): MaybePromise<Answer<{ outcome: string }>>;
  settle(
    envelope: DataEnvelope,
    actor: string,
    opId: string,
    now: number,
  ): MaybePromise<SettleDecision["answer"]>;
  acknowledge(
    envelope: DataEnvelope,
    actor: string,
    opId: string,
    now: number,
  ): MaybePromise<boolean>;
  alarm(now: number): MaybePromise<{ pruned: number }>;
  flushReads(now: number): MaybePromise<void>;
  /**
   * The same `get` `times` times, answering the last: one call into the object, so a test that
   * needs thousands of reads does not pay a request for each.
   */
  getMany(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    id: string,
    context: Context,
    times: number,
  ): MaybePromise<Answer<Record<string, unknown>>>;
  /** The same `create` `times` times, answering the last: with one operation ID, replays. */
  createMany(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    body: unknown,
    context: Context,
    times: number,
  ): MaybePromise<Answer<Record<string, unknown>>>;
  connect(
    envelope: DataEnvelope,
    author: string | null,
    principal: string,
    deadline: number,
    context: Context,
  ): MaybePromise<Answer<string>>;
  renew(
    envelope: DataEnvelope,
    socketId: string,
    principal: string,
    deadline: number,
    context: Context,
  ): MaybePromise<boolean>;
  message(socketId: string, text: string, now: number): MaybePromise<void>;
  /** Memory goes (pending usage, attempts, connections); storage stays. */
  evict(): MaybePromise<void>;
  view(): MaybePromise<ObjectView>;
  setFaults(faults: DriverFaults): MaybePromise<void>;
  setRowBounds(bounds: Partial<Record<OperationKind, number>>): MaybePromise<void>;
  /** Puts retained control rows in place, outside any command. */
  seed(rows: SeedRows): MaybePromise<void>;
}

/** Makes a fresh, empty object; `name` seeds its deterministic document and socket IDs. */
export type MakeObject = (name?: string) => Promise<DataObject>;
