// The envelope every command carries and the control record the artifact's object keeps
// (decision 0026, "The control record"). One validator, `admit`, decides every command: page and
// owner requests, operator commands, maintenance, fences and every erase step. The control record
// holds what a D1 restore can lose about the object (its owner and the transition that made it
// owner, the epoch, the generation, a pending erase, a hold, a quarantine), so `reconcile` can
// repair D1 from it, or quarantine the data when the two cannot be made to agree.

export interface Envelope {
  artifactId: string;
  region: string;
  /** The owner the calling Worker authorized against. */
  ownerId: string;
  /** The data generation: raised by every erase of the whole data. */
  generation: number;
  /** The lifecycle epoch: raised by holds, releases, transfers, suspensions and access changes. */
  epoch: number;
  /** A durable operation ID for mutations, scoped by the object to the actor and generation. */
  opId?: string;
}

export interface Transition {
  /** The transition's own ID, from the D1 batch that ordered it: repeats are recognized by it. */
  id: string;
  kind: "created" | "transfer" | "hold" | "release";
  epoch: number;
  fromOwner: string | null;
  toOwner: string;
  at: number;
}

export interface Control {
  artifactId: string;
  region: string;
  ownerId: string;
  /** The epoch at which the current owner took over: leases are bound to it. */
  ownerEpoch: number;
  generation: number;
  epoch: number;
  /** A hold, kept independently of everything else (the transition that set it). */
  hold: { transition: string; epoch: number } | null;
  /** Set only by reconciliation after a restore; cleared only by the operator. */
  quarantine: { reason: "owner" | "hold"; at: number } | null;
  /** A whole-data erase prepared and not yet committed or cancelled, with its target. */
  erasing: { generation: number; epoch: number } | null;
  last: Transition;
  /** Raised by every transaction that may change storage, maintenance and refusals included. */
  storageSeq: number;
  /** Raised only by changes to the documents: what an export compares for consistency. */
  payloadRevision: number;
}

export type Mode =
  /** A page or owner-side command; `create` lets a first write create the control record. */
  | { kind: "request"; create: boolean }
  /** The operator's commands (export under a hold, resolving a quarantine). */
  | { kind: "operator" }
  /** A step of an erase, with the generation it targets. */
  | { kind: "erase" }
  /** Housekeeping on this artifact (pruning, audit settlement): artifact and region must match. */
  | { kind: "maintenance" };

export type Verdict =
  | { ok: true; adopt: boolean; empty: boolean }
  | { ok: true; done: true }
  | { ok: false; error: "forbidden" | "stale" | "held" | "quarantined"; message: string };

const FORBIDDEN = {
  ok: false,
  error: "forbidden",
  message: "artifact reference mismatch",
} as const;

/**
 * The one rule. A different artifact or region is refused for every mode. Maintenance needs
 * only that. A quarantine refuses all but the operator. A different owner is stale (ownership
 * changes only by a fence). An older epoch is stale and a newer one is adopted. A different
 * generation is stale, except that an erase step for an older one is done. A hold refuses all
 * but the operator. A pending erase refuses requests.
 */
export function admit(stored: Control | null, envelope: Envelope, mode: Mode): Verdict {
  if (stored === null) return { ok: true, adopt: true, empty: true };
  if (stored.artifactId !== envelope.artifactId || stored.region !== envelope.region)
    return FORBIDDEN;
  if (mode.kind === "maintenance") return { ok: true, adopt: false, empty: false };
  if (stored.quarantine !== null && mode.kind !== "operator") {
    return { ok: false, error: "quarantined", message: "This artifact's data is unavailable." };
  }
  if (stored.ownerId !== envelope.ownerId) {
    return { ok: false, error: "stale", message: "the artifact changed owner" };
  }
  if (envelope.epoch < stored.epoch) {
    return { ok: false, error: "stale", message: "the artifact changed since this request began" };
  }
  if (envelope.generation !== stored.generation) {
    if (mode.kind === "erase" && envelope.generation < stored.generation)
      return { ok: true, done: true };
    return { ok: false, error: "stale", message: "the data was erased since this request began" };
  }
  if (stored.hold !== null && mode.kind !== "operator") {
    return { ok: false, error: "held", message: "This artifact cannot be changed right now." };
  }
  if (stored.erasing !== null && mode.kind === "request") {
    return { ok: false, error: "stale", message: "the data is being erased" };
  }
  return { ok: true, adopt: envelope.epoch > stored.epoch, empty: false };
}

export function newControl(envelope: Envelope, now: number): Control {
  return {
    artifactId: envelope.artifactId,
    region: envelope.region,
    ownerId: envelope.ownerId,
    ownerEpoch: envelope.epoch,
    generation: envelope.generation,
    epoch: envelope.epoch,
    hold: null,
    quarantine: null,
    erasing: null,
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

/** What a fence asks: a hold or release, or a new owner; `transition` is its ID from D1. */
export interface FenceChange {
  state: "open" | "held";
  toOwner?: string;
  transition: string;
}

export type FenceResult =
  | { ok: true; control: Control; repeated: boolean }
  | { ok: false; error: "forbidden" | "stale"; message: string };

/**
 * Applies a fence. It must name the object's artifact, region, generation and current owner,
 * and carry a newer epoch; the same transition delivered again is acknowledged without change;
 * anything else at the same or an older epoch is stale. On an empty object it creates the
 * control record, so the fence holds before any data exists. A quarantine survives every fence.
 */
export function applyFence(
  stored: Control | null,
  envelope: Envelope,
  change: FenceChange,
  now: number,
): FenceResult {
  const base = stored ?? newControl({ ...envelope, epoch: -1 }, now);
  if (base.artifactId !== envelope.artifactId || base.region !== envelope.region) return FORBIDDEN;
  if (envelope.generation !== base.generation) {
    return { ok: false, error: "stale", message: "the fence names another generation" };
  }
  if (stored !== null && base.last.id === change.transition) {
    return { ok: true, control: stored, repeated: true };
  }
  if (base.ownerId !== envelope.ownerId) {
    return { ok: false, error: "stale", message: "the fence names another owner" };
  }
  if (envelope.epoch <= base.epoch) {
    return { ok: false, error: "stale", message: "a fence needs a newer epoch" };
  }
  const nextOwner = change.toOwner ?? base.ownerId;
  const transfer = nextOwner !== base.ownerId;
  const kind = transfer ? "transfer" : change.state === "held" ? "hold" : "release";
  return {
    ok: true,
    repeated: false,
    control: {
      ...base,
      ownerId: nextOwner,
      ownerEpoch: transfer ? envelope.epoch : base.ownerEpoch,
      epoch: envelope.epoch,
      hold:
        change.state === "held" ? { transition: change.transition, epoch: envelope.epoch } : null,
      // A hold or a transfer cancels a prepared erase: the erase job must start again under
      // the new state, so it never commits against data it no longer may touch.
      erasing: change.state === "held" || transfer ? null : base.erasing,
      last: {
        id: change.transition,
        kind,
        epoch: envelope.epoch,
        fromOwner: base.ownerId,
        toOwner: nextOwner,
        at: now,
      },
      storageSeq: base.storageSeq + 1,
    },
  };
}

/** What D1 says about the artifact's data after a restore (holds re-applied first). */
export interface RestoredRow {
  ownerId: string;
  generation: number;
  epoch: number;
  held: boolean;
}

export type Reconciliation =
  | { action: "none" }
  | { action: "raise"; generation: number; epoch: number }
  | { action: "resume_erase"; generation: number; epoch: number }
  | { action: "quarantine"; reason: "owner" | "hold" }
  | { action: "operator"; reason: "quarantined" };

/**
 * After a D1 restore, compares D1 with the object's control record. Field authority: the
 * artifact and region must match the directory (checked by the caller); the owner comes from the
 * object's last verified transfer; a hold from the object's hold record against D1's re-applied
 * holds; a pending erase from the object, resumed with its own target, never skipped by raising
 * numbers. The same owner and hold raise D1 to the object's generation and epoch. Anything else
 * quarantines; a quarantine waits for the operator.
 */
export function reconcile(row: RestoredRow, object: Control | null): Reconciliation {
  if (object === null) return { action: "none" };
  if (object.quarantine !== null) return { action: "operator", reason: "quarantined" };
  if (object.ownerId !== row.ownerId) return { action: "quarantine", reason: "owner" };
  if ((object.hold !== null) !== row.held) return { action: "quarantine", reason: "hold" };
  if (object.erasing !== null) {
    return {
      action: "resume_erase",
      generation: object.erasing.generation,
      epoch: Math.max(object.epoch, row.epoch),
    };
  }
  if (object.generation === row.generation && object.epoch === row.epoch) return { action: "none" };
  return {
    action: "raise",
    generation: object.generation,
    epoch: Math.max(object.epoch, row.epoch) + 1,
  };
}
