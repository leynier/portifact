// Counted work (decision 0027, "Budget"): parses of HTML, renders of documents, anchor indexes, source maps and
// decoded character references. Every planner takes a meter and counts into it, so tests assert what a
// plan costs without timing it, and a caller can log the counts.

export interface Work {
  parses: number;
  renders: number;
  indexes: number;
  /** Source maps built: a plain text file's, or one HTML text node's. */
  maps: number;
  /** Distinct character references decoded while mapping HTML. */
  decodes: number;
  /** Long attribute values hashed (synchronously) for identity evidence. */
  hashes: number;
  /**
   * Selector work for previews of element operations: each compound of a selector decided for
   * one element, each node a query walks and each sibling counted for `:nth-of-type`.
   */
  selectorSteps: number;
}

export const newWork = (): Work => ({
  parses: 0,
  renders: 0,
  indexes: 0,
  maps: 0,
  decodes: 0,
  hashes: 0,
  selectorSteps: 0,
});
