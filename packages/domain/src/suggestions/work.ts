// Counted work (decision 0027, "Budget"): parses of HTML, renders of documents, anchor indexes and
// plain text source maps. Every planner takes a meter and counts into it, so tests assert what a
// plan costs without timing it, and a caller can log the counts.

export interface Work {
  parses: number;
  renders: number;
  indexes: number;
  maps: number;
}

export const newWork = (): Work => ({ parses: 0, renders: 0, indexes: 0, maps: 0 });
