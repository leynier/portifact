// Moderation rules (docs/operations.md, "Reports" and "Legal holds"): where a decision came from,
// whether a legal hold may be placed, and what a report keeps of its reporter. Pure.
import type { AbuseReason, DecisionSource } from "@portifact/contracts";
import { fail, ok, type Result } from "./result.ts";

/**
 * Whether a decision followed a notice or the operator's own review: what the operator says, or
 * a notice when it names a report.
 */
export function decisionSource(
  explicit: DecisionSource | undefined,
  reportId: string | undefined,
): DecisionSource {
  return explicit ?? (reportId ? "notice" : "review");
}

/**
 * The reporter's name a report keeps: none for child sexual abuse or exploitation, where the
 * form does not ask for it and the law lets a notice leave it out.
 */
export function reporterNameKept(reason: AbuseReason, name: string | undefined): string | null {
  if (reason === "child_safety") return null;
  return name?.trim() || null;
}

/**
 * Whether a hold may be placed on an artifact in `state`: only a suspended one, so its content is
 * served to nobody, and a planned release only in the future.
 */
export function checkHoldPlacement(
  state: string,
  releaseAt: number | null,
  now: number,
): Result<true> {
  if (state !== "suspended") {
    return fail("invalid_input", "Suspend the artifact first: a held artifact is never served.");
  }
  if (releaseAt !== null && releaseAt <= now) {
    return fail("invalid_input", "The release date must be in the future.");
  }
  return ok(true);
}

/** The message every refusal because of a hold gives: it never says why. */
export const HELD_MESSAGE =
  "This artifact cannot be changed, moved or deleted right now. Write to abuse@portifact.com.";
