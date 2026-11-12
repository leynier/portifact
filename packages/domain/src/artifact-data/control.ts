// The control record and the one validator (decision 0026, "The control record and the
// validator"). Every command of the documents object, maintenance and every erase step included,
// is admitted by `admit`; lifecycle changes reach the object only as fences (`applyFence`); a D1
// restore is repaired from the object by `reconcile`, or quarantined for the operator.
import type {
  AdmitMode,
  DataControl,
  DataEnvelope,
  DataFence,
  QuarantineReason,
  TransitionKind,
} from "@portifact/contracts/artifact-data";
import { accept, type Decision, type Refusal, refuse } from "./decision.ts";

export type Verdict = { ok: true; empty: boolean } | { ok: true; done: true } | Refusal;

const FORBIDDEN = refuse("forbidden", "artifact reference mismatch");

/** Whether the stored record names another artifact or region than the envelope. */
export function namesAnotherArtifact(stored: DataControl, envelope: DataEnvelope): boolean {
  return stored.artifactId !== envelope.artifactId || stored.region !== envelope.region;
}

/**
 * The one rule, checked in this order: another artifact or region is refused in every mode;
 * maintenance needs only that. A quarantine refuses all but the operator. Another owner is stale
 * (ownership moves only by a fence). An older epoch is stale; a newer one is admitted and never
 * adopted, so a request never consumes the epoch a pending fence needs. Another generation is
 * stale, except that an erase step for an older one is done. A hold refuses all but the operator.
 * A prepared erase refuses requests.
 */
export function admit(
  stored: DataControl | null,
  envelope: DataEnvelope,
  mode: AdmitMode,
): Verdict {
  if (stored === null) return { ok: true, empty: true };
  if (namesAnotherArtifact(stored, envelope)) return FORBIDDEN;
  if (mode.kind === "maintenance") return { ok: true, empty: false };
  if (stored.quarantine !== null && mode.kind !== "operator") {
    return refuse("quarantined", "This artifact's data is unavailable.");
  }
  if (stored.ownerId !== envelope.ownerId) return refuse("stale", "the artifact changed owner");
  if (envelope.epoch < stored.epoch) {
    return refuse("stale", "the artifact changed since this request began");
  }
  if (envelope.generation !== stored.generation) {
    if (mode.kind === "erase" && envelope.generation < stored.generation) {
      return { ok: true, done: true };
    }
    return refuse("stale", "the data was erased since this request began");
  }
  if (stored.hold !== null && mode.kind !== "operator") {
    return refuse("held", "This artifact cannot be changed right now.");
  }
  if (stored.erasing !== null && mode.kind === "request") {
    return refuse("stale", "the data is being erased");
  }
  return { ok: true, empty: false };
}

/**
 * The control record a first durable write binds from its envelope. The envelope's epoch becomes
 * the admission floor and the bound epoch, never an applied fence: a hold, a transfer or an erase
 * at that same epoch, ordered by D1 before the request read it, still applies.
 */
export function newControl(envelope: DataEnvelope, now: number): DataControl {
  return {
    artifactId: envelope.artifactId,
    region: envelope.region,
    ownerId: envelope.ownerId,
    ownerEpoch: envelope.epoch,
    generation: envelope.generation,
    epoch: envelope.epoch,
    boundEpoch: envelope.epoch,
    fencedEpoch: null,
    hold: null,
    quarantine: null,
    erasing: null,
    lastErase: null,
    last: {
      id: "created",
      kind: "created",
      epoch: envelope.epoch,
      fromOwner: null,
      toOwner: envelope.ownerId,
      at: now,
    },
    storageSeq: 0,
    payloadRevision: 0,
  };
}

/**
 * Raises the storage sequence, which every durable write moves, and the payload revision when
 * documents changed. A refusal that wrote nothing does not call it.
 */
export function touched(control: DataControl, payload: boolean): DataControl {
  return {
    ...control,
    storageSeq: control.storageSeq + 1,
    payloadRevision: control.payloadRevision + (payload ? 1 : 0),
  };
}

export interface FenceApplied {
  control: DataControl;
  /** The same transition delivered again: acknowledged, nothing written. */
  repeated: boolean;
  /** A prepared erase this fence ended, to be recorded as cancelled. */
  cancelledErase: string | null;
  /** Live connections close at every fence that was applied. */
  closeConnections: boolean;
  /** A release re-arms maintenance. */
  rearm: boolean;
}

function kindOf(fence: DataFence): TransitionKind {
  return fence.kind;
}

/** Whether a repeat of the last transition's ID carries its contents. */
function sameTransition(control: DataControl, envelope: DataEnvelope, fence: DataFence): boolean {
  const last = control.last;
  if (last.kind !== kindOf(fence) || last.epoch !== envelope.epoch) return false;
  return fence.kind !== "transfer" || fence.toOwner === last.toOwner;
}

/**
 * Applies a fence. It names the object's artifact, region and generation; a repeat of the last
 * transition's ID must carry the same contents and is acknowledged without change, anything else
 * under that ID is a conflict; otherwise it needs the current owner and an epoch newer than the
 * last fence applied, or, before any fence, at least the epoch the object was bound at. On an empty object it binds the identity, so the fence holds before any data exists.
 * A transfer of a held artifact is refused: only an explicit release ends a hold. A hold or a
 * transfer ends a prepared erase. A quarantine survives every fence.
 */
export function applyFence(
  stored: DataControl | null,
  envelope: DataEnvelope,
  fence: DataFence,
  now: number,
): Decision<FenceApplied> {
  if (stored !== null && namesAnotherArtifact(stored, envelope)) return FORBIDDEN;
  if (stored !== null && envelope.generation !== stored.generation) {
    return refuse("stale", "the fence names another generation");
  }
  if (stored !== null && stored.last.id === fence.transition) {
    if (!sameTransition(stored, envelope, fence)) {
      return refuse("conflict", "this transition ID was used for another change");
    }
    return accept({
      control: stored,
      repeated: true,
      cancelledErase: null,
      closeConnections: false,
      rearm: false,
    });
  }
  if (stored !== null && stored.ownerId !== envelope.ownerId) {
    return refuse("stale", "the fence names another owner");
  }
  if (stored !== null && !fenceEpochAdmitted(stored, envelope.epoch)) {
    return refuse("stale", "a fence needs a newer epoch");
  }
  const base = stored ?? newControl(envelope, now);
  if (fence.kind === "transfer") {
    if (fence.toOwner === base.ownerId)
      return refuse("invalid_input", "a transfer needs a new owner");
    if (base.hold !== null) return refuse("held", "a held artifact cannot change owner");
  }
  const toOwner = fence.kind === "transfer" ? fence.toOwner : base.ownerId;
  const ended = fence.kind === "hold" || fence.kind === "transfer" ? base.erasing : null;
  const hold =
    fence.kind === "hold"
      ? { transition: fence.transition, epoch: envelope.epoch }
      : fence.kind === "release"
        ? null
        : base.hold;
  return accept({
    control: {
      ...base,
      ownerId: toOwner,
      ownerEpoch: fence.kind === "transfer" ? envelope.epoch : base.ownerEpoch,
      epoch: Math.max(base.epoch, envelope.epoch),
      fencedEpoch: envelope.epoch,
      hold,
      erasing: ended === null ? base.erasing : null,
      lastErase: ended === null ? base.lastErase : { id: ended.id, outcome: "cancelled" },
      last: {
        id: fence.transition,
        kind: kindOf(fence),
        epoch: envelope.epoch,
        fromOwner: base.ownerId,
        toOwner,
        at: now,
      },
      storageSeq: base.storageSeq + 1,
    },
    repeated: false,
    cancelledErase: ended?.id ?? null,
    closeConnections: true,
    rearm: fence.kind === "release",
  });
}

/** A fence's epoch must pass the last fence applied, or, before any, reach the bound epoch. */
export function fenceEpochAdmitted(stored: DataControl, epoch: number): boolean {
  return stored.fencedEpoch === null ? epoch >= stored.boundEpoch : epoch > stored.fencedEpoch;
}

/**
 * Reconciliation's quarantine (after a restore, or for an object the inventory found without a
 * D1 row). Nothing but the operator acts on the data until it is resolved. An empty object holds
 * nothing to keep; an object already quarantined keeps its first reason.
 */
export function quarantine(
  stored: DataControl | null,
  envelope: DataEnvelope,
  reason: QuarantineReason,
  now: number,
): Decision<{ control: DataControl; changed: boolean }> {
  if (stored === null) return refuse("not_found", "no data to quarantine");
  if (namesAnotherArtifact(stored, envelope)) return FORBIDDEN;
  if (stored.quarantine !== null) return accept({ control: stored, changed: false });
  return accept({
    control: { ...stored, quarantine: { reason, at: now }, storageSeq: stored.storageSeq + 1 },
    changed: true,
  });
}

export interface QuarantineResolved {
  control: DataControl;
  /** `erase`: delete every payload table in the same transaction. */
  erasePayload: boolean;
  /** A prepared erase the resolution ended. */
  endedErase: string | null;
}

/**
 * The operator's exit from a quarantine. `adopt` needs an envelope naming the owner the object
 * recorded and clears the quarantine. `erase` moves to the next generation and is refused while a
 * hold stands: the hold keeps its evidence until a separately authorized release was
 * acknowledged.
 */
export function resolveQuarantine(
  stored: DataControl | null,
  envelope: DataEnvelope,
  decision: "adopt" | "erase",
): Decision<QuarantineResolved> {
  if (stored === null || stored.quarantine === null) {
    return refuse("conflict", "nothing to resolve");
  }
  const verdict = admit(stored, envelope, { kind: "operator" });
  if (!verdict.ok) return verdict;
  if ("done" in verdict) return refuse("stale", "the data was erased since this request began");
  if (decision === "adopt") {
    return accept({
      control: { ...stored, quarantine: null, storageSeq: stored.storageSeq + 1 },
      erasePayload: false,
      endedErase: null,
    });
  }
  if (stored.hold !== null) {
    return refuse("held", "a release must be acknowledged before erasing held data");
  }
  return accept({
    control: {
      ...stored,
      generation: stored.generation + 1,
      quarantine: null,
      erasing: null,
      lastErase:
        stored.erasing === null
          ? stored.lastErase
          : { id: stored.erasing.id, outcome: "committed" },
      storageSeq: stored.storageSeq + 1,
      payloadRevision: stored.payloadRevision + 1,
    },
    erasePayload: true,
    endedErase: stored.erasing?.id ?? null,
  });
}

/** What D1 says about the artifact's data after a restore, holds re-applied first. */
export interface RestoredRow {
  ownerId: string;
  generation: number;
  epoch: number;
  held: boolean;
}

export type Reconciliation =
  | { action: "none" }
  | { action: "raise"; generation: number; epoch: number }
  | { action: "resume_erase"; eraseId: string; generation: number; epoch: number }
  | { action: "quarantine"; reason: QuarantineReason }
  | { action: "operator" };

/**
 * After a D1 restore, compares D1's row with the object's control record (decision 0026,
 * "Restore"). The owner is the object's (its last verified transfer); a hold is compared with D1's
 * re-applied holds; a D1 generation ahead of the object cannot be explained. A prepared erase is
 * resumed under its own ID and target, never skipped by raising numbers, at an epoch no older than
 * the object's or the target's. With the same owner and hold, D1 is raised only when it is behind
 * the object, past the object's epoch; a second run with nothing new changes nothing. Anything else
 * quarantines; a quarantine waits for the operator. `row` is null when the inventory found the
 * object and D1 has no row.
 */
export function reconcile(row: RestoredRow | null, object: DataControl | null): Reconciliation {
  if (object === null) return { action: "none" };
  if (object.quarantine !== null) return { action: "operator" };
  if (row === null) return { action: "quarantine", reason: "orphan" };
  if (object.ownerId !== row.ownerId) return { action: "quarantine", reason: "owner" };
  if ((object.hold !== null) !== row.held) return { action: "quarantine", reason: "hold" };
  if (row.generation > object.generation) return { action: "quarantine", reason: "generation" };
  if (object.erasing !== null) {
    return {
      action: "resume_erase",
      eraseId: object.erasing.id,
      generation: object.erasing.generation,
      epoch: Math.max(object.epoch, object.erasing.epoch, row.epoch),
    };
  }
  if (row.generation === object.generation && row.epoch >= object.epoch) return { action: "none" };
  return {
    action: "raise",
    generation: object.generation,
    epoch: Math.max(row.epoch, object.epoch + 1),
  };
}
