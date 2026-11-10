// Account deletion across the global database and every region. Today one batch records the
// deletion, claims the artifacts and deletes the user. Now the user (identity) is global and the
// artifacts, comments, read sessions and openings are regional, so:
//
// 1. One global batch: the `account_deletion` job, the `account_deletions` row and the user
//    (which cascades to sessions, identities and OAuth tokens, as today). From here the account
//    cannot sign in, so it cannot start new work.
// 2. Inline, then from the job: in every region, one batch fences the owner and claims what it
//    owns (`fenceStatements`). The fence closes the window that a request authenticated before
//    step 1 could still use to land an artifact or a comment.
// 3. Each run erases a slice of the account's comments on other owners' artifacts per region.
// 4. When every region is fenced and holds nothing of the account, one global batch writes the
//    `account` tombstone, closes the job and deletes the `account_deletions` row; its returning
//    row tells exactly one concurrent run that it finished.
import { fenceStatements } from "./purge.ts";
import type { Regions } from "./regions.ts";

export async function requestAccountDeletion(
  regions: Regions,
  input: { userId: string; now: number },
): Promise<void> {
  const g = regions.global;
  await g.batch([
    g
      .prepare(
        `insert into outbox (topic, subject, available_at)
         select 'account_deletion', ?1, ?2 where exists (select 1 from users where id = ?1)`,
      )
      .bind(input.userId, input.now),
    g
      .prepare(
        "insert into account_deletions (user_id, requested_at) values (?, ?) on conflict do nothing",
      )
      .bind(input.userId, input.now),
    g.prepare("delete from users where id = ?").bind(input.userId),
  ]);
  // Stops serving at once where possible; a failure here is left to the job.
  await Promise.allSettled(
    regions.all().map(({ db }) => db.batch(fenceStatements(db, input.userId, input.now))),
  );
}

export type DeletionState = "absent" | "pending" | "finished";

export async function advanceAccountDeletion(
  regions: Regions,
  input: { userId: string; now: number; messagesPerRegion?: number },
): Promise<DeletionState> {
  const pending = await regions.global
    .prepare("select 1 as one from account_deletions where user_id = ?")
    .bind(input.userId)
    .first();
  if (!pending) return "absent";
  const limit = input.messagesPerRegion ?? 25;
  let left = 0;
  for (const { db } of regions.all()) {
    await db.batch([
      ...fenceStatements(db, input.userId, input.now),
      db
        .prepare(
          `delete from annotation_messages where id in (
             select id from annotation_messages where author_id = ?1 and owner_id <> ?1 limit ?2)`,
        )
        .bind(input.userId, limit),
    ]);
    const counted = await db
      .prepare(
        `select (select count(*) from artifacts where owner_id = ?1)
              + (select count(*) from annotation_messages where author_id = ?1 and owner_id <> ?1) as n`,
      )
      .bind(input.userId)
      .first<{ n: number }>();
    left += Number(counted?.n ?? 1);
  }
  if (left > 0) return "pending";
  const g = regions.global;
  const deletion = "exists (select 1 from account_deletions where user_id = ?1)";
  const tombstoned = "exists (select 1 from tombstones where kind = 'account' and id = ?1)";
  const results = await g.batch([
    g
      .prepare(
        `insert into tombstones (kind, id, deleted_at) select 'account', ?1, ?2 where ${deletion} on conflict do nothing`,
      )
      .bind(input.userId, input.now),
    g
      .prepare(
        `delete from outbox where topic = 'account_deletion' and subject = ?1 and ${tombstoned}`,
      )
      .bind(input.userId),
    g
      .prepare(
        `delete from account_deletions where user_id = ?1 and ${tombstoned} returning user_id`,
      )
      .bind(input.userId),
  ]);
  return (results.at(-1)?.results.length ?? 0) === 1 ? "finished" : "pending";
}
