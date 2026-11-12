// Counted work, so tests can assert what a plan costs without timing it (decision 0027, "Budget"):
// parses of HTML, renders of Markdown, anchor indexes and source maps built. Wall-clock times at
// the size limits are measured by the separate benchmark script, never in `bun run test`.
export const work = { parses: 0, renders: 0, indexes: 0, maps: 0 };

export function resetWork(): void {
  work.parses = 0;
  work.renders = 0;
  work.indexes = 0;
  work.maps = 0;
}
