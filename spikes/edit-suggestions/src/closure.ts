// Closing a change-list item by itself (decision 0027, rule 11, and rule 5 of the second round).
// The proof is made on the new version's rendered page, not on its bytes: the accepted result must
// be visible text in one text node, with the node-local context the item persisted on each side,
// in an element with the same identity (the same elements, attributes and link destinations), and
// exactly once; and the old state must be gone from every text node. Text inside comments,
// attributes, reference definitions or anything else the page does not show is never a text node,
// so it proves nothing. Any doubt keeps the item open for a person or an agent to close.
//
// - replacement: `left + after + right` once, `left + before + right` nowhere;
// - insertion: `left + after + right` once, `left + right` nowhere;
// - deletion: `left + right` once, `left + before + right` nowhere.
import type { Proof } from "./planned.ts";
import { anchoredMatches, type FileKind, renderedPage, sameIdentity } from "./rendered.ts";

/** What an item persists to prove it later (named units; text as the page shows it). */
export type ClosureProof = Pick<
  Proof,
  "nodeLeft" | "nodeRight" | "identity" | "shownBefore" | "shownAfter"
>;

export type Closure =
  | { state: "closed"; kind: "replacement" | "insertion" | "deletion"; versionId: string }
  | { state: "open"; why: "short_context" | "ambiguous" | "not_shown" | "target_changed" };

/** Context needed on the two sides together, in UTF-16 units. */
export const MIN_CONTEXT = 8;

export function closure(
  proof: ClosureProof,
  kind: FileKind,
  newSource: string,
  versionId: string,
): Closure {
  if (proof.nodeLeft.length + proof.nodeRight.length < MIN_CONTEXT) {
    return { state: "open", why: "short_context" };
  }
  const shape =
    proof.shownAfter === "" ? "deletion" : proof.shownBefore === "" ? "insertion" : "replacement";
  const page = renderedPage(kind, newSource);
  if (anchoredMatches(page, proof.nodeLeft, proof.shownBefore, proof.nodeRight).length > 0) {
    return { state: "open", why: "not_shown" };
  }
  const found = anchoredMatches(page, proof.nodeLeft, proof.shownAfter, proof.nodeRight);
  if (found.length === 0) return { state: "open", why: "not_shown" };
  if (found.length > 1) return { state: "open", why: "ambiguous" };
  const node = page.nodes[(found[0] as { node: number }).node];
  if (!node || !sameIdentity(node.identity, proof.identity)) {
    return { state: "open", why: "target_changed" };
  }
  return { state: "closed", kind: shape, versionId };
}
