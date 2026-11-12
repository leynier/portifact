// The envelope every command carries and the control record every object keeps (decision 0026,
// "Fencing"). One validator, `admit`, decides every command of both objects: requests,
// maintenance, fences and each step of an erase. The control record also holds the lifecycle
// state a D1 restore can lose (the owner, the epoch, a pending transition, a hold), so
// `reconcile` can repair D1 from the objects, or quarantine the data when it cannot.

export interface Envelope {
  artifactId: string;
  region: string;
  /** The owner the calling Worker authorized against; part of the fence, not just the epoch. */
  ownerId: string;
  /** The data generation: raised by every erase of the whole data. */
  generation: number;
  /** The lifecycle epoch: raised by holds, releases, transfers, suspensions and access changes. */
  epoch: number;
  /** A durable operation ID for mutations, scoped by the object to the actor and generation. */
  opId?: string;
}

export type ObjectState = "open" | "held" | "erasing" | "quarantined";

/** The last ownership or hold change the object accepted, kept for reconciliation. */
export interface Transition {
  kind: "transfer" | "hold" | "release" | "created";
  epoch: number;
  fromOwner: string | null;
  toOwner: string;
  at: number;
}

export interface Control {
  artifactId: string;
  region: string;
  ownerId: string;
  generation: number;
  epoch: number;
  state: ObjectState;
  /** The epoch at which the current owner took over: leases are bound to it. */
  ownerEpoch: number;
  last: Transition;
  /** Raised by every transaction that may change storage, refused work included. */
  storageSeq: number;
}

export type Mode =
  /** An ordinary command; `create` lets a first write create the control record. */
  | { kind: "request"; create: boolean }
  /** The operator's commands (export, erase under hold). */
  | { kind: "operator" }
  /** A step of an erase, with the generation it targets. */
  | { kind: "erase" };

export type Verdict =
  | { ok: true; adopt: boolean; empty: boolean }
  | { ok: true; done: true }
  | { ok: false; error: "forbidden" | "stale" | "held" | "quarantined"; message: string };

/**
 * The one rule. A different artifact or region is refused; a quarantined object refuses all
 * but the operator; a different owner is stale (ownership changes only through a fence); an
 * older epoch is stale and a newer one is adopted; a different generation is stale, except that
 * an erase step for an older generation is already done; a held object runs only the operator.
 */
export function admit(stored: Control | null, envelope: Envelope, mode: Mode): Verdict {
  if (stored === null) {
    if (mode.kind === "erase") return { ok: true, done: true };
    return { ok: true, adopt: true, empty: true };
  }
  if (stored.artifactId !== envelope.artifactId || stored.region !== envelope.region) {
    return { ok: false, error: "forbidden", message: "artifact reference mismatch" };
  }
  if (stored.state === "quarantined" && mode.kind !== "operator") {
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
  if (stored.state === "held" && mode.kind !== "operator") {
    return { ok: false, error: "held", message: "This artifact cannot be changed right now." };
  }
  if (stored.state === "erasing" && mode.kind === "request") {
    return { ok: false, error: "stale", message: "the data is being erased" };
  }
  return { ok: true, adopt: envelope.epoch > stored.epoch, empty: false };
}

/** The control record a first write or a fence creates. */
export function newControl(envelope: Envelope, state: ObjectState, now: number): Control {
  return {
    artifactId: envelope.artifactId,
    region: envelope.region,
    ownerId: envelope.ownerId,
    generation: envelope.generation,
    epoch: envelope.epoch,
    state,
    ownerEpoch: envelope.epoch,
    last: {
      kind: "created",
      epoch: envelope.epoch,
      fromOwner: null,
      toOwner: envelope.ownerId,
      at: now,
    },
    storageSeq: 0,
  };
}

/** What a fence asks: a hold or release, or a new owner (a transfer). */
export interface FenceChange {
  state: "open" | "held";
  /** Present for a transfer: the new owner. The envelope names the owner before it. */
  toOwner?: string;
}

/**
 * Applies a fence to the stored record (or a new one for an empty object). A fence must carry a
 * newer epoch than the object's, except a repeat of the same fence, which is acknowledged
 * again; it names the current owner, and a transfer names the next.
 */
export function applyFence(
  stored: Control | null,
  envelope: Envelope,
  change: FenceChange,
  now: number,
): { ok: true; control: Control } | { ok: false; error: "forbidden" | "stale"; message: string } {
  const base = stored ?? newControl({ ...envelope, epoch: 0 }, "open", now);
  if (base.artifactId !== envelope.artifactId || base.region !== envelope.region) {
    return { ok: false, error: "forbidden", message: "artifact reference mismatch" };
  }
  if (base.ownerId !== envelope.ownerId && base.ownerId !== change.toOwner) {
    return { ok: false, error: "stale", message: "the fence names another owner" };
  }
  const nextOwner = change.toOwner ?? envelope.ownerId;
  if (envelope.epoch < base.epoch)
    return { ok: false, error: "stale", message: "older than the object's epoch" };
  if (envelope.epoch === base.epoch && stored !== null) {
    const same =
      stored.ownerId === nextOwner && (stored.state === change.state || stored.state === "erasing");
    if (same) return { ok: true, control: stored };
    return { ok: false, error: "stale", message: "a fence needs a newer epoch" };
  }
  const transfer = nextOwner !== base.ownerId;
  return {
    ok: true,
    control: {
      ...base,
      ownerId: nextOwner,
      epoch: envelope.epoch,
      state: base.state === "quarantined" ? "quarantined" : change.state,
      ownerEpoch: transfer ? envelope.epoch : base.ownerEpoch,
      last: {
        kind: transfer ? "transfer" : change.state === "held" ? "hold" : "release",
        epoch: envelope.epoch,
        fromOwner: base.ownerId,
        toOwner: nextOwner,
        at: now,
      },
      storageSeq: base.storageSeq + 1,
    },
  };
}

/** What D1 says about an artifact's data after a restore. */
export interface RestoredRow {
  ownerId: string;
  generation: number;
  epoch: number;
  held: boolean;
}

export type Reconciliation =
  | { action: "none" }
  | { action: "raise"; generation: number; epoch: number }
  | { action: "quarantine"; reason: "owner" | "hold" };

/**
 * After a D1 restore, compares D1 with the object's control record. The same owner and hold
 * state: D1 is raised to the object's generation and epoch (never the other way). Anything the
 * numbers cannot explain (another owner, a hold the restore lost or invented) quarantines the
 * data until the operator resolves it: a restored owner is never blessed with a newer number.
 */
export function reconcile(row: RestoredRow, object: Control | null): Reconciliation {
  if (object === null) return { action: "none" };
  if (object.ownerId !== row.ownerId) return { action: "quarantine", reason: "owner" };
  if ((object.state === "held") !== row.held) return { action: "quarantine", reason: "hold" };
  if (object.generation === row.generation && object.epoch === row.epoch) return { action: "none" };
  return {
    action: "raise",
    generation: Math.max(object.generation, row.generation),
    epoch: Math.max(object.epoch, row.epoch) + 1,
  };
}
