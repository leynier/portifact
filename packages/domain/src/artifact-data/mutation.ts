// One transaction per command (decision 0026, "One transaction per command", decision 45). The
// documents object runs every mutation synchronously in one transaction, in this order:
//
//   1. admit the envelope, binding an empty object's identity only for an authorized first write;
//   2. look the operation record up: the same request replays after the caller's current
//      authorization, another request under the key or an aborted one is a conflict;
//   3. refuse an operation ID older than the horizon or from the future;
//   4. authorize, the author barrier first;
//   5. refuse when the class's counter is already spent (writing nothing);
//   6. count the rate attempt (refused at the limit, writing nothing);
//   7. do the work, record the operation and its audit obligation, raise the storage sequence;
//   8. add what the work measured to the class's counter.
//
// `planMutation` decides steps 1 to 6 from what the object reads (`MutationReads`, called only
// when a step needs it, so an early refusal reads little). Every terminal outcome, refusals and
// replays included, is metered by `meter` (metering.ts); a failure after the work began is charged
// in a second transaction with its rate attempt. `payloadChanged` and `auditObligation` decide what
// the work's transaction writes besides the work. Every function here is synchronous.
import type {
  ArtifactDataLimits,
  ChargeClass,
  DataControl,
  DataEnvelope,
} from "@portifact/contracts/artifact-data";
import { ERASURE_ACTOR } from "@portifact/contracts/artifact-data";
import { barrierRefusal } from "./author-erasure.ts";
import { minuteOf, rateRefusal, spentRefusal } from "./charging.ts";
import { admit, newControl } from "./control.ts";
import { type Refusal, refuse } from "./decision.ts";
import {
  type Caller,
  type CollectionFacts,
  deleteScope,
  reaches,
  removeClass,
  replaceClass,
  writeScope,
} from "./documents.ts";
import { connectDecision } from "./live.ts";
import { checkHorizon, operationKey, type PriorOperation, replayDecision } from "./operations.ts";

export type MutationKind =
  | "declare"
  | "index_step"
  | "create"
  | "replace"
  | "remove"
  | "bulk_create"
  | "bulk_replace"
  | "bulk_remove"
  | "erase_author_chunk";

/** Who runs a mutation: a caller, or the erasure job. */
export type MutationActor = Caller | { kind: "erasure" };

export interface MutationRequest {
  kind: MutationKind;
  envelope: DataEnvelope;
  actor: MutationActor;
  now: number;
  limits: ArtifactDataLimits;
  /** The request's hash (`requestHash`), binding its operation record. */
  hash: string;
  /** The collection a document command names. */
  collection?: string;
  /** The document a replace or remove names. */
  documentId?: string;
  /** The documents a bulk replace names. */
  documentIds?: string[];
  /** A replacement's new body size (all new bodies for a bulk replace), which decides its class. */
  newSize?: number;
  /** The author an erasure chunk erases. */
  author?: string;
}

/** What the object reads while deciding, each only when a step needs it. */
export interface MutationReads {
  prior(key: string): PriorOperation | null;
  barred(author: string): boolean;
  collection(name: string): CollectionFacts | null;
  /** A document's creator and stored size. */
  document(collection: string, id: string): { creator: string; size: number } | null;
  /** The total stored size of documents, or null when one of them is missing. */
  documentsSize(collection: string, ids: readonly string[]): number | null;
  /** The day's counter of a class, reads counted in memory included. */
  used(charge: ChargeClass): number;
  /** A visitor's own rights row for today. */
  rights(author: string): number;
  /** The caller's attempts this minute, this one included, kept in memory. */
  callerAttempts(): number;
  /** The rate row's count for a subject, kind and minute. */
  rate(subject: string, kind: "writes" | "deletes", window: number): number;
}

export interface Proceed {
  decision: "proceed";
  /** The control record as the work starts: freshly bound for an empty object's first write. */
  control: DataControl;
  /** Whether this transaction binds the object's identity (writes the control record first). */
  binds: boolean;
  /** The operation record's key, or null for a mutation without an operation ID. */
  key: string | null;
  charge: ChargeClass;
  /** For a rights charge: the visitor whose own allowance pays. */
  rightsAuthor: string | null;
  /** The rate row to count in step 6 (already checked), or null. */
  rate: { subject: string; kind: "writes" | "deletes"; window: number } | null;
}

export type MutationPlan =
  | { decision: "refused"; refusal: Refusal }
  | {
      decision: "replayed";
      answer: { kind: string; target: string; result: Record<string, number> | null };
    }
  | Proceed;

export function mutationActorName(actor: MutationActor): string {
  if (actor.kind === "erasure") return ERASURE_ACTOR;
  if (actor.kind === "visitor") return actor.author;
  if (actor.kind === "owner") return `owner:${actor.actor ?? "owner"}`;
  return "reader";
}

/** Kinds whose first write may bind an empty object's identity, and who may do it. */
function mayBind(request: MutationRequest): boolean {
  if (request.kind === "declare") return request.actor.kind === "owner";
  return request.kind === "erase_author_chunk" && request.actor.kind === "erasure";
}

const refused = (refusal: Refusal): MutationPlan => ({ decision: "refused", refusal });

/**
 * Step 4's caller-level checks, which a replay repeats: the barrier, who may run the kind, and the
 * collection's mode. Answers the collection's facts for the steps after it.
 */
function authorizeCaller(
  request: MutationRequest,
  reads: MutationReads,
): Refusal | { collection: CollectionFacts | null } {
  const actor = request.actor;
  if (actor.kind === "visitor" && reads.barred(actor.author)) {
    return barrierRefusal({ kind: "own_command" });
  }
  switch (request.kind) {
    case "erase_author_chunk":
      return actor.kind === "erasure" ? { collection: null } : refuse("forbidden", "erasure only");
    case "declare":
    case "index_step":
      if (actor.kind !== "owner") return refuse("forbidden", "owner side only");
      return { collection: null };
    case "bulk_create":
    case "bulk_replace":
    case "bulk_remove":
      if (actor.kind !== "owner") return refuse("forbidden", "owner side only");
      break;
    default:
      if (actor.kind === "erasure") return refuse("forbidden", "not an erasure step");
  }
  const collection = reads.collection(request.collection ?? "");
  if (collection === null) return refuse("not_found", "no such collection");
  const caller = actor as Caller;
  if (request.kind === "create" || request.kind === "replace") {
    if (writeScope(collection.mode, caller) === "none") {
      return refuse("forbidden", "you cannot write to this collection");
    }
  }
  if (request.kind === "remove" && deleteScope(collection.mode, caller) === "none") {
    return refuse("forbidden", "you cannot delete in this collection");
  }
  return { collection };
}

/** The rest of step 4 for document commands: the document, its reach and its creator's barrier. */
function authorizeDocument(
  request: MutationRequest,
  collection: CollectionFacts,
  reads: MutationReads,
): Refusal | { creator: string; size: number } {
  const caller = request.actor as Caller;
  const found = reads.document(request.collection ?? "", request.documentId ?? "");
  const scope =
    request.kind === "replace"
      ? writeScope(collection.mode, caller)
      : deleteScope(collection.mode, caller);
  if (found === null || !reaches(scope, caller, found.creator)) {
    return refuse("not_found", "no such document");
  }
  if (request.kind === "replace" && reads.barred(found.creator)) {
    return barrierRefusal({ kind: "edit_created_by" });
  }
  return found;
}

function chargeOf(
  request: MutationRequest,
  document: { creator: string; size: number } | null,
): ChargeClass {
  switch (request.kind) {
    case "replace":
    case "bulk_replace":
      return replaceClass(document?.size ?? 0, request.newSize ?? Number.MAX_SAFE_INTEGER);
    case "remove":
      return removeClass(request.actor as Caller, document?.creator ?? "");
    case "bulk_remove":
    case "erase_author_chunk":
      return "cleanup";
    default:
      return "growth";
  }
}

function rateOf(request: MutationRequest): Proceed["rate"] {
  if (request.actor.kind !== "visitor") return null;
  const kind = request.kind === "remove" ? "deletes" : "writes";
  return { subject: request.actor.author, kind, window: minuteOf(request.now) };
}

function rateLimit(request: MutationRequest, kind: "writes" | "deletes"): number {
  return kind === "writes"
    ? request.limits.writesPerAuthorPerMinute
    : request.limits.deletesPerAuthorPerMinute;
}

/** Steps 1 to 6 of a mutation. A refusal or a replay writes nothing. */
export function planMutation(
  stored: DataControl | null,
  request: MutationRequest,
  reads: MutationReads,
): MutationPlan {
  const verdict = admit(stored, request.envelope, { kind: "request", create: mayBind(request) });
  if (!verdict.ok) return refused(verdict);
  let control = stored;
  if (control === null) {
    if (!mayBind(request)) {
      return refused(
        request.actor.kind === "visitor" || request.actor.kind === "reader"
          ? refuse("not_found", "no such collection")
          : refuse("forbidden", "only a declaration or an erasure step writes first"),
      );
    }
    control = newControl(request.envelope, request.now);
  }
  const opId = request.envelope.opId;
  const key =
    opId === undefined
      ? null
      : operationKey(mutationActorName(request.actor), request.envelope.generation, opId);
  if (key !== null && stored !== null) {
    const replay = replayDecision(reads.prior(key), request.hash);
    if (!replay.ok) return refused(replay);
    if (replay.value.kind === "replay") {
      const again = authorizeCaller(request, reads);
      if ("ok" in again) return refused(again);
      const attempt = replayAttempt(request, reads);
      if (attempt !== null) return refused(attempt);
      return { decision: "replayed", answer: replay.value.answer };
    }
  }
  if (opId !== undefined) {
    const horizon = checkHorizon(opId, request.now);
    if (!horizon.ok) return refused(horizon);
  }
  const caller = authorizeCaller(request, reads);
  if ("ok" in caller) return refused(caller);
  let document: { creator: string; size: number } | null = null;
  if (request.kind === "replace" || request.kind === "remove") {
    const found = authorizeDocument(request, caller.collection as CollectionFacts, reads);
    if ("ok" in found) return refused(found);
    document = found;
  }
  if (request.kind === "bulk_replace") {
    const ids = request.documentIds ?? [];
    if (new Set(ids).size !== ids.length) {
      return refused(refuse("invalid_input", "a bulk replace names each document once"));
    }
    const size = reads.documentsSize(request.collection ?? "", ids);
    if (size === null) return refused(refuse("not_found", "no such document"));
    document = { creator: "", size };
  }
  const charge = chargeOf(request, document);
  const rightsAuthor = charge === "rights" ? (request.actor as { author: string }).author : null;
  if (request.kind !== "erase_author_chunk") {
    const used = rightsAuthor === null ? reads.used(charge) : reads.rights(rightsAuthor);
    const spent = spentRefusal(charge, used, request.limits);
    if (spent !== null) return refused(spent);
  }
  const rate = rateOf(request);
  if (rate !== null) {
    const limited = rateRefusal(
      reads.rate(rate.subject, rate.kind, rate.window),
      rateLimit(request, rate.kind),
    );
    if (limited !== null) return refused(limited);
  }
  return {
    decision: "proceed",
    control,
    binds: stored === null,
    key,
    charge,
    rightsAuthor,
    rate,
  };
}

/**
 * A replay is a read attempt: it repeats no effect and no charge of the original operation, but
 * it passes the caller's minute (visitors and readers) and the read class like any read. The
 * erasure job's replays are protected.
 */
function replayAttempt(request: MutationRequest, reads: MutationReads): Refusal | null {
  const kind = request.actor.kind;
  if (kind === "erasure") return null;
  if (kind !== "owner" && reads.callerAttempts() > request.limits.readsPerCallerPerMinute) {
    return refuse("rate_limited", "too many reads, try again in a minute");
  }
  return spentRefusal("read", reads.used("read"), request.limits);
}

/** What a mutation's work changed, as the work reports it. */
export interface WorkDone {
  /** Documents created, replaced, deleted or re-attributed. */
  documents: number;
  /** A collection created or an indexed field added (an export's header changes). */
  declared: boolean;
}

/**
 * Whether the payload revision rises: only when a document or a declaration changed, so an index
 * step, a bulk delete that found nothing or an erasure chunk with nothing left leave a quiet
 * export consistent.
 */
export function payloadChanged(done: WorkDone): boolean {
  return done.documents > 0 || done.declared;
}

const AUDIT_KINDS: Record<MutationKind, string> = {
  declare: "data.collection_set",
  index_step: "data.index_step",
  create: "data.document_created",
  replace: "data.document_replaced",
  remove: "data.document_deleted",
  bulk_create: "data.documents_created",
  bulk_replace: "data.documents_replaced",
  bulk_remove: "data.documents_deleted",
  erase_author_chunk: "data.author_erased",
};

/**
 * The audit obligation a mutation writes in its own transaction under its operation's key: every
 * owner-side mutation and every erasure chunk, with counts only; visitors' writes have none.
 */
export function auditObligation(
  kind: MutationKind,
  actor: MutationActor,
  detail: Record<string, number | boolean>,
): { kind: string; detail: Record<string, number | boolean> } | null {
  if (actor.kind !== "owner" && actor.kind !== "erasure") return null;
  return { kind: AUDIT_KINDS[kind], detail };
}

/** Reads (gets, queries, counts): admission, the caller's minute in memory, the read class. */
export function planRead(input: {
  stored: DataControl | null;
  envelope: DataEnvelope;
  caller: Caller;
  limits: ArtifactDataLimits;
  /** This caller's reads in the current minute, this one included (kept in memory). */
  callerReads: number;
  used: number;
  /** The caller is a visitor whose author was erased. */
  barred: boolean;
}): { decision: "empty" } | { decision: "refused"; refusal: Refusal } | { decision: "proceed" } {
  const verdict = admit(input.stored, input.envelope, { kind: "request", create: false });
  if (!verdict.ok) return { decision: "refused", refusal: verdict };
  if (input.stored === null) return { decision: "empty" };
  if (input.barred) {
    return { decision: "refused", refusal: barrierRefusal({ kind: "own_command" }) };
  }
  if (input.caller.kind !== "owner" && input.callerReads > input.limits.readsPerCallerPerMinute) {
    return {
      decision: "refused",
      refusal: refuse("rate_limited", "too many reads, try again in a minute"),
    };
  }
  const spent = spentRefusal("read", input.used, input.limits);
  if (spent !== null) return { decision: "refused", refusal: spent };
  return { decision: "proceed" };
}

/**
 * An export page: the owner side's spends export, a visitor's own export spends rights, and the
 * operator's (under a hold or a quarantine too) is counted and never refused.
 */
export function planExport(input: {
  stored: DataControl | null;
  envelope: DataEnvelope;
  who: "owner" | "visitor" | "operator";
  limits: ArtifactDataLimits;
  /** A class's counter today; for a visitor, `rights` is their own row. */
  used: (charge: ChargeClass) => number;
  /** For a visitor's own export: their author was erased. */
  barred: boolean;
}):
  | { decision: "empty" }
  | { decision: "refused"; refusal: Refusal }
  | { decision: "proceed"; charge: ChargeClass } {
  const mode =
    input.who === "operator"
      ? ({ kind: "operator" } as const)
      : ({ kind: "request", create: false } as const);
  const verdict = admit(input.stored, input.envelope, mode);
  if (!verdict.ok) return { decision: "refused", refusal: verdict };
  if (input.stored === null) return { decision: "empty" };
  if (input.who === "visitor" && input.barred) {
    return { decision: "refused", refusal: barrierRefusal({ kind: "own_command" }) };
  }
  const charge: ChargeClass = input.who === "visitor" ? "rights" : "export";
  if (input.who !== "operator") {
    const spent = spentRefusal(charge, input.used(charge), input.limits);
    if (spent !== null) return { decision: "refused", refusal: spent };
  }
  return { decision: "proceed", charge };
}

/**
 * A live connection: admission, the plan's connection counts and deadline (`connectDecision`), the
 * growth class (a connect spends growth) and the per-author connect rate. Refusals write nothing.
 */
export function planConnect(input: {
  stored: DataControl | null;
  envelope: DataEnvelope;
  barred: boolean;
  deadline: number;
  now: number;
  open: number;
  openForAuthor: number;
  limits: ArtifactDataLimits;
  usedGrowth: number;
  connectsThisMinute: number;
}): Refusal | null {
  const verdict = admit(input.stored, input.envelope, { kind: "request", create: false });
  if (!verdict.ok) return verdict;
  const decided = connectDecision({ ...input, hasData: input.stored !== null });
  if (!decided.ok) return decided;
  return (
    spentRefusal("growth", input.usedGrowth, input.limits) ??
    rateRefusal(input.connectsThisMinute, input.limits.connectsPerAuthorPerMinute)
  );
}
