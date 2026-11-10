// Which versions an artifact still retains, as SQL, from its owner's plan read now (premium plan
// P3; rules in packages/domain/src/versions.ts). Every reader of retention (the version list and
// manifest, downloads and reads, rollback, the artifact list's version count) and the pruning scan
// use this one condition, so a version is listed exactly until it is pruned.
import { retentionCutoff, type VersionRetention } from "@portifact/domain";
import { type SQL, sql } from "drizzle-orm";

/**
 * Previous versions replaced after the row's version: those that count against the plan's number
 * of previous versions before it. Names its tables, so it holds in select fields too.
 */
const NEWER_PREVIOUS = sql`(select count(*) from "versions" as "newer" where "newer"."artifact_id" = "versions"."artifact_id" and "newer"."state" = 'committed' and "newer"."superseded_at" is not null and "newer"."number" > "versions"."number")`;

/**
 * True for a previous version (a committed `versions` row that was replaced) still inside the
 * owner's retention at `now`: replaced less than the plan's days ago and among its most recent
 * previous versions.
 */
export function previousRetainedSql(retention: VersionRetention, now: number): SQL {
  return sql`("versions"."state" = 'committed' and "versions"."superseded_at" > ${retentionCutoff(retention, now)} and ${NEWER_PREVIOUS} < ${retention.previousVersions})`;
}

/** The negation for the pruning scan: a replaced version the owner's plan no longer keeps. */
export function previousPrunableSql(retention: VersionRetention, now: number): SQL {
  return sql`("versions"."state" = 'committed' and "versions"."superseded_at" is not null and ("versions"."superseded_at" <= ${retentionCutoff(retention, now)} or ${NEWER_PREVIOUS} >= ${retention.previousVersions}))`;
}

/** The artifact's current version (`current`, an ID or a column) or a retained previous one. */
export function retainedVersionSql(current: SQL, retention: VersionRetention, now: number): SQL {
  return sql`(("versions"."state" = 'committed' and "versions"."id" = ${current}) or ${previousRetainedSql(retention, now)})`;
}
