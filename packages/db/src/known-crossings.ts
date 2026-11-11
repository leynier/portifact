// The region guard's list of known crossings (decision 0005, "Two-region audit"). Kept apart from
// the guard, with no Workers types, so `scripts/region-guard-known.test.ts` reads it.

/**
 * Product functions known to cross the two databases, keyed `<file>#<function>`. The list is
 * empty and must stay empty: every path is correct with a separate regional database, and the
 * strict guard fails any statement that reaches the wrong one. A future crossing must be fixed
 * (one handle through `bothSides` with one database, global first then per region with a separate
 * one, or the outbox), never listed here; `packages/db/test/region-guard.test.ts` fails when an
 * entry is added, and `scripts/region-guard-known.test.ts` when one names nothing.
 */
export const KNOWN_CROSS_DATABASE: Readonly<Record<string, string>> = {};
