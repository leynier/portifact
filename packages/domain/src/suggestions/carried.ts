// A suggestion's proofs across versions (decision 0027, "Suggestions and new versions"). The
// submitted edit never changes: where its text is on the current version's page, and the proof
// that places it there, are kept beside it (`SuggestionProofs`), written when the suggestion is
// planned and rewritten by each verified carry. These functions turn a plan into those proofs,
// give the operations as they stand on a version, and prepare and read a carry; they decide
// nothing a planner or `carryAll` does not.
import type {
  CarryOutdatedReason,
  Edit,
  EditOperation,
  SuggestionProofs,
  TextOperation,
} from "@portifact/contracts";
import { textEditOf } from "./edit.ts";
import type { BuiltPlan } from "./plan.ts";
import type { Carriable, Carry } from "./relocate.ts";

/**
 * The proofs a plan establishes for an edit's operations (as given to the plan), on `versionId`:
 * an operation the plan mapped gets its position and proof; any other gets null.
 */
export function proofsOfPlan(
  plan: Pick<BuiltPlan, "proofs" | "operations">,
  operations: readonly EditOperation[],
  versionId: string,
): SuggestionProofs {
  const entries: SuggestionProofs["operations"] = operations.map(() => null);
  plan.operations.forEach((index, at) => {
    const proof = plan.proofs[at];
    const edit = textEditOf(operations[index] as EditOperation);
    if (proof && edit) entries[index] = { start: edit.start, end: edit.end, proof };
  });
  return { format: 1, versionId, operations: entries };
}

/** Whether the proofs hold an operation located on `versionId`. */
export function plannedOn(proofs: SuggestionProofs | null, versionId: string): boolean {
  return proofs?.versionId === versionId && proofs.operations.some((entry) => entry !== null);
}

/**
 * The edit's operations as they stand on `versionId`: a carried suggestion's text operations at
 * the positions its last carry proved, and as submitted otherwise.
 */
export function operationsOn(
  edit: Edit,
  proofs: SuggestionProofs | null,
  versionId: string,
): EditOperation[] {
  if (proofs?.versionId !== versionId) return edit.operations;
  return edit.operations.map((operation, index) => {
    const entry = proofs.operations[index];
    if (!entry || operation.kind !== "text" || operation.target.anchor.kind !== "text") {
      return operation;
    }
    const target = operation.target;
    const anchor = { ...target.anchor, position: { start: entry.start, end: entry.end } };
    return { ...operation, target: { ...target, anchor } } as TextOperation;
  });
}

/**
 * What a carry of one suggestion takes, or why it cannot be carried at all: every operation must
 * be a text operation with a proof on the version the suggestion is on.
 */
export function carryRequest(
  edit: Edit,
  proofs: SuggestionProofs | null,
  versionId: string,
): { items: Carriable[] } | { outdated: CarryOutdatedReason } {
  if (proofs?.versionId !== versionId) return { outdated: "not_planned" };
  const items: Carriable[] = [];
  for (const [index, operation] of edit.operations.entries()) {
    const entry = proofs.operations[index];
    const text = textEditOf(operation);
    if (!entry || !text) return { outdated: "not_planned" };
    items.push({ edit: { ...text, start: entry.start, end: entry.end }, proof: entry.proof });
  }
  return { items };
}

/**
 * The proofs after a carry to `versionId`, or the first reason an operation was outdated: a
 * suggestion is carried only when every operation is.
 */
export function carriedProofs(
  results: readonly Carry[],
  versionId: string,
): SuggestionProofs | { outdated: CarryOutdatedReason } {
  const operations: SuggestionProofs["operations"] = [];
  for (const result of results) {
    if (result.status === "outdated") return { outdated: result.reason };
    operations.push({ start: result.edit.start, end: result.edit.end, proof: result.proof });
  }
  return { format: 1, versionId, operations };
}
