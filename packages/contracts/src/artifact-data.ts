// Wire and storage shapes of an artifact's document database (decision 0026, delivery 3). Nothing
// here is reachable by a user yet: these are the contracts the documents object (delivery 4), the
// owner API (delivery 5) and the page (delivery 6) will share. Stored records are parsed with
// loose objects, so a field a later version adds survives a rewrite by this one; a field this
// version decides on keeps a strict type, so a record it cannot understand fails closed.
import { z } from "zod";
import { ArtifactId } from "./core.ts";

const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** Milliseconds since the epoch. */
const Time = Count;

/** A region's name, as the directory stores it (`default`, `eu`). */
export const DataRegion = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "Invalid region");
export type DataRegion = z.infer<typeof DataRegion>;

/** An owner: a user ID (personal space) or a workspace ID. */
export const DataOwnerId = z.string().min(1).max(128);

/**
 * An operation ID: `<issue time in ms, 13 digits>.<random>`. The Worker stamps it from the
 * client's idempotency key; the object refuses one issued too long ago or in the future, so an ID
 * whose record was pruned can never apply again (decision 0026, "Operation records and replay").
 * Erase intents use the same form, for the same reason.
 */
export const OperationId = z
  .string()
  .regex(/^[0-9]{13}\.[A-Za-z0-9_-]{8,64}$/, "Invalid operation id");
export type OperationId = z.infer<typeof OperationId>;
export const EraseId = OperationId;

/** A lifecycle transition's ID, from the D1 batch that ordered it. */
export const TransitionId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, "Invalid transition id");

/**
 * A visitor's opaque per-artifact ID, claimed in the author journal. Its prefix keeps it apart
 * from the owner side's author (`owner`) and the erased marker (`erased`).
 */
export const VisitorId = z.string().regex(/^v_[A-Za-z0-9_-]{16,64}$/, "Invalid visitor id");
export type VisitorId = z.infer<typeof VisitorId>;

/** The author the owner side writes as, and the marker an erased editor leaves. */
export const OWNER_AUTHOR = "owner";
export const ERASED_EDITOR = "erased";
/** The system actor that runs erasure steps. */
export const ERASURE_ACTOR = "system:erasure";

/**
 * Why a whole erase is required by the lifecycle: set only by the jobs Worker for a purge or an
 * account or workspace deletion, never by the document API, and never rate limited.
 */
export const REQUIRED_ERASES = ["purge", "account_deletion", "workspace_deletion"] as const;
export const RequiredErase = z.enum(REQUIRED_ERASES);
export type RequiredErase = z.infer<typeof RequiredErase>;

/** What every command carries, filled by the calling Worker from D1. */
export const DataEnvelope = z.strictObject({
  artifactId: ArtifactId,
  region: DataRegion,
  ownerId: DataOwnerId,
  generation: Count,
  epoch: Count,
  opId: OperationId.optional(),
  /** Only on an erase step the lifecycle requires; a document command carrying it is refused. */
  requiredErase: RequiredErase.optional(),
});
export type DataEnvelope = z.infer<typeof DataEnvelope>;

/**
 * A lifecycle command's envelope as another Worker sends it (delivery 4): no operation ID and no
 * erase reason, which the object's lifecycle methods set themselves from their own arguments.
 */
export const LifecycleEnvelope = DataEnvelope.omit({ opId: true, requiredErase: true });
export type LifecycleEnvelope = z.infer<typeof LifecycleEnvelope>;

/** A command's time as the calling Worker passes it, in milliseconds since the epoch. */
export const DataTime = Time;

/** The steps of a whole erase. */
export const EraseStepName = z.enum(["prepare", "commit", "cancel"]);
export type EraseStepName = z.infer<typeof EraseStepName>;

/** The operator's two ways out of a quarantine. */
export const QuarantineResolution = z.enum(["adopt", "erase"]);
export type QuarantineResolution = z.infer<typeof QuarantineResolution>;

export const TRANSITION_KINDS = ["created", "transfer", "hold", "release", "epoch"] as const;
export const TransitionKind = z.enum(TRANSITION_KINDS);
export type TransitionKind = z.infer<typeof TransitionKind>;

/** The last lifecycle transition the object applied, with its contents for repeats. */
export const Transition = z.looseObject({
  id: TransitionId,
  kind: TransitionKind,
  epoch: Count,
  fromOwner: DataOwnerId.nullable(),
  toOwner: DataOwnerId,
  at: Time,
});
export type Transition = z.infer<typeof Transition>;

export const QUARANTINE_REASONS = ["owner", "hold", "orphan", "generation"] as const;
export const QuarantineReason = z.enum(QUARANTINE_REASONS);
export type QuarantineReason = z.infer<typeof QuarantineReason>;

/**
 * The state of a quarantined object the operator reviewed (`data-findings`): the quarantine's
 * reason and time and the identity numbers the object held then. A resolution applies only to
 * exactly this state.
 */
export const ReviewedQuarantine = z.strictObject({
  artifactId: ArtifactId,
  region: DataRegion,
  /** The object's own count of quarantines when this one began: one quarantine of one object. */
  incarnation: Count,
  reason: QuarantineReason,
  ownerId: DataOwnerId,
  generation: Count,
  epoch: Count,
});
export type ReviewedQuarantine = z.infer<typeof ReviewedQuarantine>;

/**
 * The operator's resolution of one quarantine, as an operation with an identity: its ID (the
 * erase ID's form, recorded with its outcome like an ended erase intent, so a retry finishes the
 * same resolution), the decision, the state it was reviewed against, and the hold D1 has, which
 * an adoption makes the object keep.
 */
export const QuarantineResolutionRequest = z.strictObject({
  id: OperationId,
  decision: QuarantineResolution,
  expected: ReviewedQuarantine,
  hold: z.strictObject({ transition: TransitionId }).nullable(),
});
export type QuarantineResolutionRequest = z.infer<typeof QuarantineResolutionRequest>;

export const ERASE_OUTCOMES = ["committed", "cancelled"] as const;
export const EraseEnd = z.enum(ERASE_OUTCOMES);
export type EraseEnd = z.infer<typeof EraseEnd>;

/** The control record the object keeps in `pf_meta` (decision 0026, "The control record"). */
export const DataControl = z.looseObject({
  artifactId: ArtifactId,
  region: DataRegion,
  ownerId: DataOwnerId,
  ownerEpoch: Count,
  generation: Count,
  /** The admission floor: requests with an older epoch are stale. */
  epoch: Count,
  /** The epoch the first durable write bound the object at; never a fence. */
  boundEpoch: Count,
  /** The epoch of the last fence applied, or null before any: a fence at the bound epoch applies. */
  fencedEpoch: Count.nullable(),
  hold: z.looseObject({ transition: TransitionId, epoch: Count }).nullable(),
  /**
   * The open quarantine: its reason, when it began (for the operator, never compared) and its
   * incarnation, the object's own quarantine count when it began (`quarantines`).
   */
  quarantine: z
    .looseObject({ reason: QuarantineReason, at: Time, incarnation: Count.optional() })
    .nullable(),
  /** How many quarantines this object ever began: raised by each, never by a caller's time. */
  quarantines: Count.optional(),
  /** A prepared erase: its ID and immutable target (generation and epoch). */
  erasing: z.looseObject({ id: EraseId, generation: Count, epoch: Count }).nullable(),
  lastErase: z.looseObject({ id: EraseId, outcome: EraseEnd }).nullable(),
  last: Transition,
  storageSeq: Count,
  payloadRevision: Count,
  /**
   * Raised by every transition that closes live connections (an applied fence, a quarantine and
   * its resolution, a prepared or committed erase). A connection carries the value it opened
   * under, so one recovered after hibernation whose close was lost is still refused.
   */
  liveEpoch: Count,
});
export type DataControl = z.infer<typeof DataControl>;

/** A lifecycle fence: a hold, its release, a transfer, or an epoch raise (archive, suspension). */
export const DataFence = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hold"), transition: TransitionId }),
  z.strictObject({ kind: z.literal("release"), transition: TransitionId }),
  z.strictObject({ kind: z.literal("epoch"), transition: TransitionId }),
  z.strictObject({ kind: z.literal("transfer"), transition: TransitionId, toOwner: DataOwnerId }),
]);
export type DataFence = z.infer<typeof DataFence>;

/** The four admission modes of the one validator. */
export const AdmitMode = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("request"), create: z.boolean() }),
  z.strictObject({ kind: z.literal("operator") }),
  z.strictObject({ kind: z.literal("erase") }),
  z.strictObject({ kind: z.literal("maintenance") }),
]);
export type AdmitMode = z.infer<typeof AdmitMode>;

/** Refusal codes the object produces. */
export const DATA_REFUSAL_CODES = [
  "forbidden",
  "stale",
  "held",
  "quarantined",
  "conflict",
  "not_found",
  "invalid_input",
  "quota_exceeded",
  "rate_limited",
] as const;
export const DataRefusalCode = z.enum(DATA_REFUSAL_CODES);
export type DataRefusalCode = z.infer<typeof DataRefusalCode>;

/**
 * A refusal as a client parses it: the code stays an open lowercase string, because a released
 * CLI must not fail on a code a later server adds.
 */
export const DataRefusalWire = z.looseObject({
  code: z.string().regex(/^[a-z][a-z_]{0,47}$/),
  message: z.string().max(500),
});

/**
 * The most indexed fields a collection can hold under any plan, retained ones after a downgrade
 * included: every per-operation row bound is derived from it.
 */
export const MAX_INDEXED_FIELDS = 8;
/** The most collections an artifact can hold under any plan: it bounds describe. */
export const MAX_COLLECTIONS = 32;

/**
 * The largest document any plan may allow: one row holds the body, its indexed values and the
 * server fields, and must stay well under the platform's row limit (Durable Object SQLite
 * documents 8 MB a row). Decision 0026, delivery 4 (platform limits).
 */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
/**
 * The largest artifact data any plan may allow: growth is refused once the file passes this plus
 * the control reserve, which leaves a gigabyte under the platform's 10 GB per object for the work
 * the size check never judges (cleanup, rights and protected work, which can still add index
 * entries and control records).
 */
export const MAX_ARTIFACT_BYTES = 9_000_000_000;

/**
 * The plan's per-artifact limits, sent with every command (decision 45). Limits the platform cannot
 * hold are refused whatever plan sends them (`MAX_DOCUMENT_BYTES`, `MAX_ARTIFACT_BYTES`).
 */
export const ArtifactDataLimits = z.strictObject({
  bytesPerArtifact: Positive.max(MAX_ARTIFACT_BYTES),
  documentBytes: Positive.max(MAX_DOCUMENT_BYTES),
  documentsPerCollection: Positive,
  collections: Positive.max(MAX_COLLECTIONS),
  indexedFields: Count.max(MAX_INDEXED_FIELDS),
  writesPerAuthorPerMinute: Positive,
  deletesPerAuthorPerMinute: Positive,
  readsPerCallerPerMinute: Positive,
  rowsReadPerDay: Positive,
  rowsWrittenPerDay: Positive,
  cleanupRowsPerDay: Positive,
  exportRowsPerDay: Positive,
  rightsRowsPerDay: Positive,
  liveMessagesPerDay: Count,
  connectionsPerArtifact: Count,
  connectionsPerAuthor: Count,
  connectsPerAuthorPerMinute: Count,
});
export type ArtifactDataLimits = z.infer<typeof ArtifactDataLimits>;

/**
 * The daily counters' classes (decision 0026, "The classes"). Live messages have their own.
 * `protected` records lifecycle and legally required work (fences, erase steps, settlement,
 * acknowledgement, pruning, quarantine cleanup, live reservations): measured, never refused, and
 * drawing on no visitor's or owner's allowance. `rights` is reserved per visitor.
 */
export const CHARGE_CLASSES = [
  "growth",
  "read",
  "cleanup",
  "export",
  "rights",
  "protected",
] as const;
export const ChargeClass = z.enum(CHARGE_CLASSES);
export type ChargeClass = z.infer<typeof ChargeClass>;

/** One UTC day's counters of an artifact. */
export const DayCounters = z.looseObject({
  day: Count,
  growth: Count,
  read: Count,
  cleanup: Count,
  export: Count,
  /** Every visitor's rights rows together, for accounting; each visitor's own row refuses. */
  rights: Count,
  protected: Count,
  live: Count,
  refused: Count,
  /** Erase intents started today, admitted up to `erase.intentsPerDay`. */
  intents: Count,
});
export type DayCounters = z.infer<typeof DayCounters>;

/**
 * The protocol's constants. Per-operation caps bound what one operation can overshoot a spent
 * counter by; retention bounds the control tables.
 */
export const ARTIFACT_DATA = {
  caps: {
    pageDocuments: 100,
    bulkDocuments: 100,
    indexStepDocuments: 500,
    eraseChunkDocuments: 500,
    exportRows: 500,
    exportBytes: 1024 * 1024,
    pruneRows: 500,
  },
  /** The charge statement's own rows, added to what the cursors measured. */
  chargeSelf: { read: 2, written: 2 },
  /** Reads are counted in memory and persisted at most this far apart. */
  /**
   * Reads and refusals are counted in memory. Rows and refusals are flushed synchronously by the
   * command that reaches either bound, so an eviction loses at most that many; the 30 seconds is a
   * target the alarm aims at and may miss by its lateness.
   */
  readFlush: { rows: 10_000, refusals: 1_000, ms: 30_000 },
  /** How long an operation record answers a retry. */
  replayMs: 86_400_000,
  /** An operation ID issued longer ago than this is refused: one hour less than `replayMs`. */
  horizonMs: 82_800_000,
  /** An operation ID issued further ahead of the command's time than this is refused. */
  clockSkewMs: 300_000,
  /** Delivered audit obligations are kept this long for late settlement. */
  deliveredMs: 7 * 86_400_000,
  /** Rate rows are kept a day after their minute. */
  rateKeepMinutes: 1_440,
  /** Day counters are kept this many days after their day. */
  dayKeepDays: 2,
  /** Room above the data cap for control records. */
  controlReserveBytes: 256 * 1024,
  /**
   * Retention alarms are batched: the next one is rounded up to this window, and one alarm prunes
   * everything due by then.
   */
  alarmBatchMs: 3_600_000,
  /** Distinct erase intents an artifact may start per UTC day. */
  erase: { intentsPerDay: 20 },
  /** Maintenance that found a full pass comes back this soon. */
  morePruneMs: 60_000,
  /** Alarms are never set closer than this to now. */
  alarmFloorMs: 1_000,
  /** Values longer than this are not indexed, and equalities on them are refused. */
  indexValueBytes: 256,
  maxDepth: 16,
  /** A retired journal entry is kept this long: longer than any grant or code can live. */
  journalRetiredMs: 31 * 86_400_000,
  /**
   * A retired inventory entry is kept this long: longer than D1 Time Travel's 30-day window, so
   * any restore that could bring the artifact's row back still finds its object.
   */
  inventoryRetiredMs: 31 * 86_400_000,
  live: {
    messageBytes: 1024,
    messagesInPerMinute: 4,
    bytesOutPerMinute: 256 * 1024,
    subscriptions: 20,
    reserveChunk: 100,
    /** The longest deadline a connection may hold. */
    deadlineMs: 60_000,
  },
} as const;

/** Close codes of a live connection. */
export const LIVE_CLOSE = {
  renew: 4001,
  reconnect: 4003,
  tooManyIn: 4008,
  slowDown: 4009,
  daySpent: 4029,
  erased: 4410,
} as const;
export type LiveCloseCode = (typeof LIVE_CLOSE)[keyof typeof LIVE_CLOSE];

export const CollectionName = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "Invalid collection");
export const FieldName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/, "Invalid field");

export const COLLECTION_MODES = ["own", "append", "read", "shared"] as const;
export const CollectionMode = z.enum(COLLECTION_MODES);
export type CollectionMode = z.infer<typeof CollectionMode>;

/** The owner side's declaration of a collection. Mode and unique key are fixed once declared. */
export const CollectionDeclaration = z.strictObject({
  name: CollectionName,
  mode: CollectionMode,
  uniqueKey: FieldName.optional(),
  indexed: z.array(FieldName).max(MAX_INDEXED_FIELDS).optional(),
});
export type CollectionDeclaration = z.infer<typeof CollectionDeclaration>;

export const IndexState = z.enum(["building", "ready"]);

/** What describe answers for one collection. */
export const CollectionInfo = z.looseObject({
  name: CollectionName,
  mode: CollectionMode,
  uniqueKey: FieldName.nullable(),
  indexed: z.array(z.looseObject({ field: FieldName, state: IndexState })).max(MAX_INDEXED_FIELDS),
  documents: Count,
  bytes: Count,
});
export type CollectionInfo = z.infer<typeof CollectionInfo>;

/** A document ID: 12 random bytes in base64url. */
export const DocumentId = z.string().regex(/^[A-Za-z0-9_-]{16}$/, "Invalid document id");

/** A document as it is answered: its body's fields plus the server fields. */
export const StoredDocument = z.looseObject({
  _id: DocumentId,
  _by: z.string().min(1),
  _editedBy: z.string().min(1).nullable(),
  _created: Time,
  _updated: Time,
  _seq: Count,
});
export type StoredDocument = z.infer<typeof StoredDocument>;

const QueryValue = z.union([z.string().max(1024), z.number().finite(), z.boolean()]);

/** A query in one of the bounded shapes (decision 0026, "The document model"). */
export const DataQuery = z.strictObject({
  collection: CollectionName,
  equals: z
    .strictObject({ field: z.union([z.literal("_by"), FieldName]), value: QueryValue })
    .optional(),
  created: z.strictObject({ op: z.enum(["gt", "gte", "lt", "lte"]), value: Time }).optional(),
  order: z.enum(["created", "-created"]).optional(),
  limit: z.number().int().min(1).max(ARTIFACT_DATA.caps.pageDocuments).optional(),
  after: z.string().min(1).max(512).optional(),
});
export type DataQuery = z.infer<typeof DataQuery>;

/** The object's storage, reported with every answer, refusals included. */
export const StorageReport = z.looseObject({ generation: Count, seq: Count, bytes: Count });
export type StorageReport = z.infer<typeof StorageReport>;

/** An operation record: bound to a hash of the request, never holding a body. */
export const OperationRecord = z.looseObject({
  key: z.string().min(1).max(512),
  actor: z.string().min(1),
  requestHash: z.string().regex(/^([0-9a-f]{64})?$/),
  state: z.enum(["committed", "aborted"]),
  kind: z.string().min(1).max(64),
  target: z.string().max(256),
  /** Counts only (erasure chunks, bulk operations), as JSON; never a body. */
  result: z.record(z.string(), Count).nullable(),
  at: Time,
});
export type OperationRecord = z.infer<typeof OperationRecord>;

/** What a replayed mutation answers: that it was done and what it named, never a body. */
export const ReplayAnswer = z.looseObject({
  replayed: z.literal(true),
  kind: z.string(),
  target: z.string(),
  result: z.record(z.string(), Count).nullable(),
});
export type ReplayAnswer = z.infer<typeof ReplayAnswer>;

/** An audit obligation, under the operation's full key. Details are counts and flags only. */
export const AuditObligation = z.looseObject({
  key: z.string().min(1).max(512),
  kind: z.string().regex(/^data\.[a-z_]{1,48}$/),
  detail: z.record(z.string(), z.union([Count, z.boolean()])),
  owner: DataOwnerId,
  state: z.enum(["pending", "delivered"]),
  at: Time,
});
export type AuditObligation = z.infer<typeof AuditObligation>;

/** The audit relay's answer from `settle`. */
export const SettleAnswer = z.discriminatedUnion("state", [
  z.looseObject({
    state: z.literal("committed"),
    kind: z.string(),
    detail: z.record(z.string(), z.union([Count, z.boolean()])).nullable(),
    delivered: z.boolean(),
  }),
  z.looseObject({ state: z.literal("aborted") }),
  /** Not decided now (an ID from the future, or another artifact): ask again later. */
  z.looseObject({ state: z.literal("refused"), code: z.string() }),
]);
export type SettleAnswer = z.infer<typeof SettleAnswer>;

/** How an erase step ended, the same for a retry. */
export const EraseStepAnswer = z.looseObject({
  outcome: z.enum(["prepared", "committed", "cancelled", "superseded"]),
});
export type EraseStepAnswer = z.infer<typeof EraseStepAnswer>;

/** An author erasure chunk's answer, replayed with the same counts. */
export const EraseChunkAnswer = z.looseObject({
  documents: Count,
  edits: Count,
  more: z.boolean(),
});
export type EraseChunkAnswer = z.infer<typeof EraseChunkAnswer>;

/** The author journal's entry in the region's bucket (decision 0026, "Author erasure"). */
export const JournalEntry = z.looseObject({
  /** Null only in an entry written retired, for a person who never had one. */
  visitorId: VisitorId.nullable(),
  firstGrantAt: Time,
  retiredAt: Time.optional(),
});
export type JournalEntry = z.infer<typeof JournalEntry>;

/**
 * The object inventory's entry in the region's bucket (decision 0026, "Restore"): written before
 * an object can hold anything, retired once a whole erase that ends the artifact committed.
 */
export const InventoryEntry = z.looseObject({
  artifactId: ArtifactId,
  region: DataRegion,
  createdAt: Time,
  retiredAt: Time.optional(),
});
export type InventoryEntry = z.infer<typeof InventoryEntry>;

/** The export file (decision 0026, "Export"): JSON Lines, versioned, never reordered. */
export const DATA_EXPORT_FORMAT = "portifact-data";
export const DATA_EXPORT_VERSION = 1;

export const DataExportHeader = z.looseObject({
  format: z.literal(DATA_EXPORT_FORMAT),
  version: Positive,
  artifact: ArtifactId,
  generation: Count,
  revision: Count,
  collections: z.array(
    z.looseObject({
      name: CollectionName,
      mode: CollectionMode,
      uniqueKey: FieldName.nullable(),
      indexed: z.array(FieldName),
    }),
  ),
});
export type DataExportHeader = z.infer<typeof DataExportHeader>;

export const DataExportRow = z.looseObject({
  collection: CollectionName,
  id: DocumentId,
  by: z.string().min(1),
  editedBy: z.string().min(1).nullable(),
  created: Time,
  updated: Time,
  body: z.record(z.string(), z.unknown()),
});
export type DataExportRow = z.infer<typeof DataExportRow>;

export const DataExportFooter = z.looseObject({
  footer: z.literal(true),
  revision: Count,
  consistent: z.boolean(),
  documents: Count,
});
export type DataExportFooter = z.infer<typeof DataExportFooter>;

/** An export page's position: the last row's primary key. */
export const ExportCursor = z.strictObject({ collection: CollectionName, id: DocumentId });
export type ExportCursor = z.infer<typeof ExportCursor>;

const DocumentBody = z.record(z.string(), z.unknown());

/** The owner side's bulk create: one operation, all or nothing, up to `caps.bulkDocuments`. */
export const BulkCreate = z.strictObject({
  collection: CollectionName,
  documents: z.array(DocumentBody).min(1).max(ARTIFACT_DATA.caps.bulkDocuments),
});
export type BulkCreate = z.infer<typeof BulkCreate>;

/** The owner side's bulk replace: one operation, all or nothing, distinct IDs. */
export const BulkReplace = z.strictObject({
  collection: CollectionName,
  documents: z
    .array(z.strictObject({ id: DocumentId, body: DocumentBody }))
    .min(1)
    .max(ARTIFACT_DATA.caps.bulkDocuments),
});
export type BulkReplace = z.infer<typeof BulkReplace>;

/** A count from maintained counters: a collection, one author, or one built indexed value. */
export const DataCount = z.strictObject({
  collection: CollectionName,
  by: z.string().min(1).max(80).optional(),
  equals: z.strictObject({ field: FieldName, value: QueryValue }).optional(),
});
export type DataCount = z.infer<typeof DataCount>;

/** Describe: every collection, the data's generation and revision, and today's counters. */
export const DataDescription = z.looseObject({
  generation: Count,
  revision: Count,
  collections: z.array(CollectionInfo).max(MAX_COLLECTIONS),
  today: DayCounters,
});
export type DataDescription = z.infer<typeof DataDescription>;

/**
 * The envelope of an owner-side command as the app Worker sends it (delivery 5): an operation ID
 * on a mutation, never an erase reason (only the lifecycle's own paths set that).
 */
export const OwnerEnvelope = DataEnvelope.omit({ requiredErase: true });
export type OwnerEnvelope = z.infer<typeof OwnerEnvelope>;

/** Who acts on the owner side: the user's or the service token's ID, as the audit names it. */
export const OwnerActor = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "Invalid actor");

/** One owner-side command (`ownerCommand` on the documents object), parsed at the boundary. */
export const OwnerDataCommand = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("describe") }),
  z.strictObject({ kind: z.literal("declare"), declaration: CollectionDeclaration }),
  z.strictObject({ kind: z.literal("index_step") }),
  z.strictObject({
    kind: z.literal("create"),
    collection: CollectionName,
    body: DocumentBody,
  }),
  z.strictObject({ kind: z.literal("get"), collection: CollectionName, id: DocumentId }),
  z.strictObject({
    kind: z.literal("replace"),
    collection: CollectionName,
    id: DocumentId,
    body: DocumentBody,
  }),
  z.strictObject({ kind: z.literal("remove"), collection: CollectionName, id: DocumentId }),
  z.strictObject({ kind: z.literal("bulk_create"), input: BulkCreate }),
  z.strictObject({ kind: z.literal("bulk_replace"), input: BulkReplace }),
  z.strictObject({
    kind: z.literal("bulk_remove"),
    collection: CollectionName,
    ids: z.array(DocumentId).min(1).max(ARTIFACT_DATA.caps.bulkDocuments),
  }),
  z.strictObject({ kind: z.literal("query"), query: DataQuery }),
  z.strictObject({ kind: z.literal("count"), count: DataCount }),
  z.strictObject({ kind: z.literal("export"), after: ExportCursor.nullable() }),
]);
export type OwnerDataCommand = z.infer<typeof OwnerDataCommand>;

/** Owner-side commands that change data, and so carry an operation ID and an audit job. */
export const OWNER_MUTATIONS = [
  "declare",
  "index_step",
  "create",
  "replace",
  "remove",
  "bulk_create",
  "bulk_replace",
  "bulk_remove",
] as const satisfies readonly OwnerDataCommand["kind"][];
