// Erasing the whole data in two steps under an erase ID (decision 0026, "Erasing the whole data,
// under an erase ID"). Prepare records the intent and its target; commit deletes every payload
// table and writes the next generation in one transaction; cancel ends the intent. Every step
// matches the intent's ID, a retried step answers how the intent ended, and every step is refused
// while a hold stands. Ended intents are kept as records under their ID for `replayMs` after they
// ended, so a delayed step of an intent that already ended is recognized however many intents
// ended after it. The issue-time horizon applies only to starting an intent the object does not
// know: a prepared intent stays finishable and cancellable under its ID after any delay, and its
// target (generation and epoch) never changes.
import {
  ARTIFACT_DATA,
  type DataControl,
  type DataEnvelope,
  type EraseEnd,
} from "@portifact/contracts/artifact-data";
import { admit, namesAnotherArtifact, newControl } from "./control.ts";
import { accept, type Decision, refuse } from "./decision.ts";
import { checkHorizon, operationKey } from "./operations.ts";

export type EraseOutcome = "prepared" | "committed" | "cancelled" | "superseded";

export interface EraseStep {
  outcome: EraseOutcome;
  /** The control record to write, or null when the step writes nothing. */
  control: DataControl | null;
  /** Commit only: delete every payload table in this transaction. */
  erasePayload: boolean;
  /** The ended intent to record under its ID, with how it ended. */
  ended: { id: string; outcome: EraseEnd } | null;
  /** Live connections close at a prepared erase and at its commit. */
  closeConnections: boolean;
  /** This step started a new intent: it counts in the day's `intents`. */
  startsIntent: boolean;
}

const NOTHING = {
  control: null,
  erasePayload: false,
  ended: null,
  closeConnections: false,
  startsIntent: false,
};

/** The checks every step shares: the artifact, an intent that ended, then admission. */
function common(
  stored: DataControl | null,
  envelope: DataEnvelope,
  ended: EraseEnd | null,
): Decision<EraseStep | null> {
  if (stored !== null && namesAnotherArtifact(stored, envelope)) {
    return refuse("forbidden", "artifact reference mismatch");
  }
  if (ended !== null) return accept({ outcome: ended, ...NOTHING });
  const verdict = admit(stored, envelope, { kind: "erase" });
  if (!verdict.ok) return verdict;
  if ("done" in verdict) return accept({ outcome: "superseded", ...NOTHING });
  return accept(null);
}

/** A step's envelope may be newer than the prepared target (a restore), never older. */
function olderThanTarget(control: DataControl, envelope: DataEnvelope): boolean {
  return control.erasing !== null && envelope.epoch < control.erasing.epoch;
}

const OLDER = refuse("stale", "this step is older than the prepared erase");

/**
 * Step one: records `erasing { id, generation, epoch }` and closes live connections at that
 * barrier. On an empty object it binds the identity. The same ID repeats while its target holds;
 * another ID while one is prepared is a conflict. Only a new intent passes the issue-time horizon,
 * and only an optional owner reset the day's admission of distinct intents (`erase.intentsPerDay`):
 * an erase the lifecycle requires (`requiredErase`) is never rate limited.
 */
export function prepareErase(
  stored: DataControl | null,
  envelope: DataEnvelope,
  eraseId: string,
  ended: EraseEnd | null,
  now: number,
  intentsToday = 0,
): Decision<EraseStep> {
  const shared = common(stored, envelope, ended);
  if (!shared.ok) return shared;
  if (shared.value !== null) return accept(shared.value);
  const base = stored ?? newControl(envelope, now);
  if (base.erasing !== null) {
    if (base.erasing.id !== eraseId) return refuse("conflict", "another erase is prepared");
    if (olderThanTarget(base, envelope)) return OLDER;
    return accept({ outcome: "prepared", ...NOTHING });
  }
  const horizon = checkHorizon(eraseId, now);
  if (!horizon.ok) return horizon;
  if (envelope.requiredErase === undefined && intentsToday >= ARTIFACT_DATA.erase.intentsPerDay) {
    return refuse("rate_limited", "too many erase intents today, try again tomorrow");
  }
  return accept({
    outcome: "prepared",
    control: {
      ...base,
      erasing: { id: eraseId, generation: envelope.generation, epoch: envelope.epoch },
      storageSeq: base.storageSeq + 1,
      liveEpoch: base.liveEpoch + 1,
    },
    erasePayload: false,
    ended: null,
    closeConnections: true,
    startsIntent: true,
  });
}

/** The prepared intent a commit or cancel names, at an envelope no older than its target. */
function prepared(
  stored: DataControl | null,
  envelope: DataEnvelope,
  eraseId: string,
  ended: EraseEnd | null,
): Decision<{ done: EraseStep } | { control: DataControl }> {
  const shared = common(stored, envelope, ended);
  if (!shared.ok) return shared;
  if (shared.value !== null) return accept({ done: shared.value });
  if (stored === null || stored.erasing?.id !== eraseId) {
    return refuse("conflict", "this erase is not the prepared one");
  }
  if (olderThanTarget(stored, envelope)) return OLDER;
  return accept({ control: stored });
}

/**
 * Step two: commits only the prepared ID. Deletes the payload (documents, collections, fields,
 * indexed values, author counts, sequences, operation records) and writes the next generation;
 * counters, barriers, audit obligations and ended intents stay.
 */
export function commitErase(
  stored: DataControl | null,
  envelope: DataEnvelope,
  eraseId: string,
  ended: EraseEnd | null,
): Decision<EraseStep> {
  const found = prepared(stored, envelope, eraseId, ended);
  if (!found.ok) return found;
  if ("done" in found.value) return accept(found.value.done);
  const control = found.value.control;
  return accept({
    outcome: "committed",
    control: {
      ...control,
      generation: control.generation + 1,
      erasing: null,
      lastErase: { id: eraseId, outcome: "committed" },
      storageSeq: control.storageSeq + 1,
      payloadRevision: control.payloadRevision + 1,
      liveEpoch: control.liveEpoch + 1,
    },
    erasePayload: true,
    ended: { id: eraseId, outcome: "committed" },
    closeConnections: true,
    startsIntent: false,
  });
}

/** Cancels only the prepared ID. */
export function cancelErase(
  stored: DataControl | null,
  envelope: DataEnvelope,
  eraseId: string,
  ended: EraseEnd | null,
): Decision<EraseStep> {
  const found = prepared(stored, envelope, eraseId, ended);
  if (!found.ok) return found;
  if ("done" in found.value) return accept(found.value.done);
  const control = found.value.control;
  return accept({
    outcome: "cancelled",
    control: {
      ...control,
      erasing: null,
      lastErase: { id: eraseId, outcome: "cancelled" },
      storageSeq: control.storageSeq + 1,
    },
    erasePayload: false,
    ended: { id: eraseId, outcome: "cancelled" },
    closeConnections: false,
    startsIntent: false,
  });
}

/**
 * The audit obligation an owner's reset leaves in its commit's own transaction (keyed like an
 * owner mutation's, under the generation it erased), so its `data.erased` event is recorded once
 * by the relay or the reset's completion even after the ended intent's receipt is pruned.
 * Lifecycle erases leave none: they record their own trail.
 */
export function erasedObligation(
  envelope: DataEnvelope,
  eraseId: string,
  actorName: string,
): { key: string; kind: "data.erased"; detail: Record<string, number> } {
  return {
    key: operationKey(actorName, envelope.generation, eraseId),
    kind: "data.erased",
    detail: {},
  };
}
