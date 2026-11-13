// Closing a change item by itself (decision 0027, "Closing by itself"). The proof is made on the
// new version's rendered page, not on its bytes: the accepted result must be visible text in one
// text node, with the node-local context the item persisted on each side, in an element with the
// same identity, exactly once; and the old state must be gone from every text node. Any doubt
// keeps the item open for a person or an agent to close.
//
// - replacement: `left + after + right` once, `left + before + right` nowhere;
// - insertion: `left + after + right` once, `left + right` nowhere;
// - deletion: `left + right` once, `left + before + right` nowhere.
import { CHANGE_LIST_LIMITS, type ClosureOpenReason, type Proof } from "@portifact/contracts";
import { sameIdentity } from "./identity.ts";
import { anchoredMatches, type RenderedPage } from "./rendered.ts";

/** What an item persists to prove it later (text as the page shows it). */
export type ClosureProof = Pick<
  Proof,
  "nodeLeft" | "nodeRight" | "identity" | "shownBefore" | "shownAfter"
>;

export type Closure =
  | { state: "closed"; kind: "replacement" | "insertion" | "deletion" }
  | { state: "open"; why: ClosureOpenReason };

/** Whether one item's change shows on a version's page; build the page once for many items. */
export function closure(proof: ClosureProof, page: RenderedPage): Closure {
  if (proof.nodeLeft.length + proof.nodeRight.length < CHANGE_LIST_LIMITS.closureMinContextUnits) {
    return { state: "open", why: "short_context" };
  }
  const kind =
    proof.shownAfter === "" ? "deletion" : proof.shownBefore === "" ? "insertion" : "replacement";
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
  return { state: "closed", kind };
}
