import type { ErrorCode } from "@portifact/contracts";

/** Why an anchor could not be created from a selection. */
export type CreateFailure =
  | "invalid_range"
  | "outside_root"
  | "empty_selection"
  | "quote_too_long"
  | "no_selector";

export type CreateResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: Extract<ErrorCode, "invalid_input">;
      reason: CreateFailure;
      message: string;
    };

export const created = <T>(value: T): CreateResult<T> => ({ ok: true, value });

export const refused = <T = never>(reason: CreateFailure, message: string): CreateResult<T> => ({
  ok: false,
  code: "invalid_input",
  reason,
  message,
});

/**
 * How well an anchor was located. `exact`: found where it was recorded. `fuzzy`: found by its
 * quote, context or fingerprint somewhere else, or with a slightly different text. `orphaned`:
 * not found or ambiguous, so the thread shows as "without location" and keeps its quote.
 */
export type Confidence = "exact" | "fuzzy" | "orphaned";

export type OrphanReason = "not_found" | "ambiguous" | "route_mismatch";

export interface Orphaned {
  readonly confidence: "orphaned";
  readonly reason: OrphanReason;
}

export const orphaned = (reason: OrphanReason): Orphaned => ({ confidence: "orphaned", reason });
