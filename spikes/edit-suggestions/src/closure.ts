// Closing a change-list item by itself (decision 0027, rule 11). An item closes only with a proof
// in a new version's stored file, never from the reviewer's text alone. The proof uses the raw
// context the server took from the old file around the change (never reviewer input), and is
// defined for each kind of text change:
//
// - replacement: `left + after + right` occurs exactly once and `left + before + right` nowhere;
// - insertion (nothing deleted): the same, with the inserted text;
// - deletion (nothing inserted): `left + right` occurs exactly once and `left + before + right`
//   nowhere.
//
// The after may be spelled as written or escaped as the planner would write it. Short contexts,
// several occurrences or a missing one keep the item open: an agent or a person closes it.

export interface ClosureFacts {
  /** Raw text of the old file just before and after the changed part. */
  left: string;
  right: string;
  deleted: string;
  inserted: string;
  /** Other spellings of `inserted` that count (Markdown escapes). */
  spellings?: readonly string[];
}

export type Closure =
  | { state: "closed"; kind: "replacement" | "insertion" | "deletion" }
  | { state: "open"; why: "short_context" | "ambiguous" | "not_shown" };

/** Context needed on each side, in UTF-16 units, so a common word cannot close an item. */
export const MIN_CONTEXT = 8;

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) n++;
  return n;
}

export function closure(facts: ClosureFacts, newSource: string): Closure {
  if (facts.left.length < MIN_CONTEXT || facts.right.length < MIN_CONTEXT) {
    return { state: "open", why: "short_context" };
  }
  const kind =
    facts.inserted === "" ? "deletion" : facts.deleted === "" ? "insertion" : "replacement";
  const old = facts.left + facts.deleted + facts.right;
  if (facts.deleted !== "" && count(newSource, old) > 0) return { state: "open", why: "not_shown" };
  const shown = [facts.inserted, ...(facts.spellings ?? [])].reduce(
    (total, spelling) => total + count(newSource, facts.left + spelling + facts.right),
    0,
  );
  if (shown === 1) return { state: "closed", kind };
  return { state: "open", why: shown === 0 ? "not_shown" : "ambiguous" };
}
