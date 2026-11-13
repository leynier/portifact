// The envelope every command carries and the control record the artifact's object keeps
// (decision 0026, "The control record"). One validator, `admit`, decides every command: page and
// owner requests, operator commands, maintenance, fences and every erase step. The control record
// holds what a D1 restore can lose about the object (its owner and the transition that made it
// owner, the epoch, the generation, a pending erase, a hold, a quarantine), so `reconcile` can
// repair D1 from it, or quarantine the data when the two cannot be made to agree.

import type { DataControl, DataFence } from "@portifact/contracts/artifact-data";
import * as production from "@portifact/domain/artifact-data";

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
  kind: "created" | "transfer" | "hold" | "release" | "epoch";
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
  quarantine: { reason: "owner" | "hold" | "orphan" | "generation"; at: number } | null;
  /** A whole-data erase prepared and not yet committed or cancelled: its ID and target. */
  erasing: { id: string; generation: number; epoch: number } | null;
  /** The last erase intent that ended, so a retried step answers what happened to it. */
  lastErase: { id: string; outcome: "committed" | "cancelled" } | null;
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
  | { ok: true; empty: boolean }
  | { ok: true; done: true }
  | { ok: false; error: "forbidden" | "stale" | "held" | "quarantined"; message: string };

/**
 * The one rule, now the production validator (`@portifact/domain/artifact-data`, delivery 3);
 * this adapter keeps the spike's answer shape (`error` for the code).
 */
export function admit(stored: Control | null, envelope: Envelope, mode: Mode): Verdict {
  const verdict = production.admit(stored as DataControl | null, envelope, mode);
  if (verdict.ok) return verdict;
  return { ok: false, error: verdict.code as "forbidden", message: verdict.message };
}

export function newControl(envelope: Envelope, now: number): Control {
  return production.newControl(envelope, now) as Control;
}

/** What a fence asks: a hold or release, or a new owner; `transition` is its ID from D1. */
export interface FenceChange {
  state: "open" | "held";
  toOwner?: string;
  transition: string;
}

export type FenceResult =
  | { ok: true; control: Control; repeated: boolean }
  | {
      ok: false;
      error: "forbidden" | "stale" | "conflict" | "held" | "invalid_input";
      message: string;
    };

/**
 * Applies a fence through the production rule (`applyFence`): the spike's `{ state, toOwner }`
 * becomes a transfer when it names another owner, else a hold or a release.
 */
export function applyFence(
  stored: Control | null,
  envelope: Envelope,
  change: FenceChange,
  now: number,
): FenceResult {
  // The envelope names the owner the fence moves from, so a repeated transfer stays a transfer.
  const fence: DataFence =
    change.toOwner !== undefined && change.toOwner !== envelope.ownerId
      ? { kind: "transfer", toOwner: change.toOwner, transition: change.transition }
      : { kind: change.state === "held" ? "hold" : "release", transition: change.transition };
  const applied = production.applyFence(stored as DataControl | null, envelope, fence, now);
  if (!applied.ok) {
    return { ok: false, error: applied.code as "stale", message: applied.message };
  }
  return { ok: true, control: applied.value.control as Control, repeated: applied.value.repeated };
}

/** What D1 says about the artifact's data after a restore (holds re-applied first). */
export type RestoredRow = production.RestoredRow;
export type Reconciliation = production.Reconciliation;

/** The production reconciliation (`reconcile`), with its field authority table. */
export function reconcile(row: RestoredRow | null, object: Control | null): Reconciliation {
  return production.reconcile(row, object as DataControl | null);
}
