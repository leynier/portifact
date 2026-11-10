// The region guard's list of crossings still to fix (decision 0005, "Two-region audit"). Kept
// apart from the guard, with no Workers types, so `scripts/region-guard-known.test.ts` reads it.

/**
 * Product functions known to cross the two databases, keyed `<file>#<function>`, each with what
 * it still does wrong (decision 0005, "Two-region audit", what remains). The strict guard lets a
 * violation through only when the nearest product frame is exactly one of these, so a function
 * of the same name elsewhere is still refused; every other crossing fails its test. Remove an
 * entry in the change that fixes it: `scripts/region-guard-known.test.ts` fails for an entry
 * that names a file or function that no longer exists.
 */
export const KNOWN_CROSS_DATABASE: Readonly<Record<string, string>> = {
  // Plans (operator only, premium plan F1): a grant writes `owner_plans` (global) and the limit
  // columns of `account_usage` and `annotation_usage` (regional) in one batch, and the scans that
  // realign them page `owner_plans` with regional joins.
  "packages/services/src/plans.ts#setOwnerPlan":
    "plan grant writes the plan row and the regional limit columns in one batch",
  "packages/services/src/plans.ts#removeOwnerPlan":
    "plan removal writes the plan row and the regional limit columns in one batch",
  "packages/services/src/plans.ts#getOwnerPlan":
    "operator view reads the plan with the regional usage rows",
  "packages/services/src/plans.ts#applyOwnerPlans":
    "re-applies exported plans with the regional limit columns",
  "packages/services/src/plans.ts#alignPlanLimits":
    "scan pages plans joined with regional usage rows",
  "packages/services/src/plans.ts#unpinLapsedPlans": "scan pages artifacts joined with plans",
  // Scans that join the owner's plan or settings to regional rows (left out of
  // `runRegionalMaintenance`, so a second region never runs them).
  "packages/services/src/maintenance.ts#pruneVersions":
    "retention reads the owner's plan in its regional query",
  "packages/services/src/expiry-notices.ts#scheduleExpiryNotices":
    "scan joins the owner's plan and settings to its artifacts",
  "packages/services/src/content-search.ts#scheduleSearchIndexing":
    "scan joins the owner's plan to its artifacts",
  "packages/services/src/content-search.ts#dropLapsedSearchIndexes":
    "scan joins the owner's plan to its index rows",
  "packages/services/src/content-search.ts#runSearchIndex":
    "job reads the owner's plan through the regional database",
  "packages/services/src/audit.ts#sweep": "audit retention joins the owner's plan to its events",
  "packages/services/src/domain-notices.ts#scheduleDomainNotices":
    "domain notices join global domains and plans",
  "packages/services/src/domain-notices.ts#planRow":
    "domain notices read the plan through the regional database",
  "packages/services/src/domain-notices.ts#exposure":
    "domain notices read global domains through the regional database",
  "packages/services/src/webhooks.ts#deliverWebhook":
    "webhook delivery reads the owner's plan in its regional query",
  "packages/services/src/webhooks.ts#removeWebhook":
    "writes the webhook tombstone in the regional batch",
  // Restores (operator only): one batch re-applies global and regional tombstones together.
  "packages/services/src/backups.ts#applyTombstones":
    "one batch re-applies global and regional tombstones",
};
