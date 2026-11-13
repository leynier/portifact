// Operation identity, replay and the horizon for old operation IDs (decision 0026, "Operation
// records and replay"), and the audit relay's settlement ("Audit with durable states"). A record
// is keyed by actor, generation and operation ID, bound to a hash of the request and holds no
// body. Records are pruned `replayMs` after they were written, and an ID issued more than
// `horizonMs` before the command's time (or more than `clockSkewMs` after it) is refused, so an
// ID whose record was pruned can never apply again.
import { ARTIFACT_DATA, ERASURE_ACTOR } from "@portifact/contracts/artifact-data";
import { accept, type Decision, refuse } from "./decision.ts";
import { sha256Hex } from "./sha256.ts";

/** The full identity of an operation: the same for its record, its audit obligation and D1's event. */
export function operationKey(actor: string, generation: number, opId: string): string {
  return `${actor}|${generation}|${opId}`;
}

const OPERATION_ID = /^([0-9]{13})\.[A-Za-z0-9_-]{8,64}$/;

/** The time an operation or erase ID was issued, which it carries as its prefix, or null. */
export function issuedAt(opId: string): number | null {
  const match = OPERATION_ID.exec(opId);
  return match === null ? null : Number(match[1]);
}

/** Refuses an ID that is malformed, issued before the horizon, or issued in the future. */
export function checkHorizon(opId: string, now: number): Decision<number> {
  const issued = issuedAt(opId);
  if (issued === null) {
    return refuse("invalid_input", "an operation ID is its issue time, a dot and a random part");
  }
  if (now - issued > ARTIFACT_DATA.horizonMs || issued - now > ARTIFACT_DATA.clockSkewMs) {
    return refuse("conflict", "this operation ID has expired; start a new operation");
  }
  return accept(issued);
}

/**
 * The hash a record is bound to: SHA-256 of the request as the Worker forwards it (its kind and
 * arguments). Synchronous, so no command awaits anything.
 */
export function requestHash(request: unknown): string {
  return sha256Hex(JSON.stringify(request) ?? "null");
}

/** What the object reads back for a key before deciding. */
export interface PriorOperation {
  requestHash: string;
  state: "committed" | "aborted";
  kind: string;
  target: string;
  result: Record<string, number> | null;
}

export type ReplayDecision =
  | { kind: "fresh" }
  | {
      kind: "replay";
      answer: { kind: string; target: string; result: Record<string, number> | null };
    };

/**
 * A recorded operation: the same request replays as done (the caller authorizes again before the
 * answer goes out); another request under the key, or an aborted operation, is a conflict.
 */
export function replayDecision(
  prior: PriorOperation | null,
  hash: string,
): Decision<ReplayDecision> {
  if (prior === null) return accept({ kind: "fresh" });
  if (prior.state === "aborted") return refuse("conflict", "this operation was abandoned");
  if (prior.requestHash !== hash) {
    return refuse("conflict", "this operation ID was used for another request");
  }
  return accept({
    kind: "replay",
    answer: { kind: prior.kind, target: prior.target, result: prior.result },
  });
}

/** What `settle` reads about an operation's key. */
export interface SettleFacts {
  obligation: {
    kind: string;
    detail: Record<string, number | boolean>;
    state: "pending" | "delivered";
  } | null;
  record: { state: "committed" | "aborted"; kind: string } | null;
  /** The actor is an erased author. */
  barred: boolean;
  /** The operation's generation is the object's current one. */
  currentGeneration: boolean;
}

export type SettleDecision =
  | {
      answer: {
        state: "committed";
        kind: string;
        detail: Record<string, number | boolean> | null;
        delivered: boolean;
      };
      writeAborted: false;
    }
  | { answer: { state: "aborted" }; writeAborted: boolean }
  | { answer: { state: "refused"; code: string }; writeAborted: false };

/**
 * The audit relay's question. A committed obligation or record is answered as committed. An
 * operation with neither is recorded as aborted, so a late arrival cannot commit, except where
 * nothing can arrive any more: an erased author (the barrier refuses them), an older generation
 * (admission refuses it) or an ID past the horizon (refused as expired); those write nothing. An
 * ID from the future is not decided now: it could still arrive within the horizon after an
 * aborted record was pruned.
 */
export function settleDecision(facts: SettleFacts, opId: string, now: number): SettleDecision {
  if (facts.obligation !== null) {
    return {
      answer: {
        state: "committed",
        kind: facts.obligation.kind,
        detail: facts.obligation.detail,
        delivered: facts.obligation.state === "delivered",
      },
      writeAborted: false,
    };
  }
  if (facts.record?.state === "committed") {
    return {
      answer: { state: "committed", kind: facts.record.kind, detail: null, delivered: true },
      writeAborted: false,
    };
  }
  if (facts.record !== null) return { answer: { state: "aborted" }, writeAborted: false };
  const issued = issuedAt(opId);
  if (issued === null) {
    return { answer: { state: "refused", code: "invalid_input" }, writeAborted: false };
  }
  if (issued - now > ARTIFACT_DATA.clockSkewMs) {
    return { answer: { state: "refused", code: "conflict" }, writeAborted: false };
  }
  const expired = now - issued > ARTIFACT_DATA.horizonMs;
  return {
    answer: { state: "aborted" },
    writeAborted: !facts.barred && facts.currentGeneration && !expired,
  };
}

/**
 * A pending audit obligation's key read back for the daily sweep (decision 0026, "Audit with
 * durable states"): who acted (the user's or token's ID behind `owner:`, or `ERASURE_ACTOR`), the
 * generation and the operation ID, with the owner it was recorded for. A visitor's key, or one
 * that does not parse, is not relayed and answers null.
 */
export function pendingObligation(
  key: string,
  owner: string,
): { actor: string; generation: number; opId: string; owner: string } | null {
  const parts = key.split("|");
  if (parts.length !== 3) return null;
  const [name, generationText, opId] = parts as [string, string, string];
  const generation = Number(generationText);
  if (!Number.isSafeInteger(generation) || generation < 0 || !OPERATION_ID.test(opId)) return null;
  if (name === ERASURE_ACTOR) return { actor: name, generation, opId, owner };
  if (!name.startsWith("owner:") || name.length === "owner:".length) return null;
  return { actor: name.slice("owner:".length), generation, opId, owner };
}
