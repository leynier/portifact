// The acceptance claim of decision 0027 (rule 12 of the second round), as SQL over a reduced
// schema, run in one transaction the way a D1 batch runs. One claim row owns everything: it is
// inserted only when the change list has room for every listed item and the suggestion (or draft)
// is still in the state the plan was confirmed against, and it carries a token unique to this run.
// Every later statement (the publication's switch, every item, the thread's completion, the
// draft's deletion) is conditioned on a claim with this run's token, so either all of them happen
// or none, a competing insertion that fills the list first makes the whole acceptance a no-op, and
// a repeated run (a duplicate queue delivery) finds the claim taken by another token and changes
// nothing. An acceptance or a draft publish that produces no version is the same batch without
// the switch: items, then completion, exactly once.
import type { DatabaseSync } from "node:sqlite";

export const SCHEMA = `
create table artifacts (id text primary key, current_version text not null);
create table suggestions (id text primary key, artifact_id text not null, state text not null, attempt text);
create table drafts (artifact_id text not null, user_id text not null, revision integer not null, primary key (artifact_id, user_id));
create table change_items (id integer primary key, artifact_id text not null, state text not null, envelope text not null);
create table acceptance_claims (attempt text primary key, run_token text not null, artifact_id text not null);
`;

export const CHANGE_LIST_CAP = 1_000;

export interface Acceptance {
  attempt: string;
  runToken: string;
  artifactId: string;
  /** The version the plan was built on; the switch happens only from it. */
  baseVersion: string;
  /** The version to switch to, or null when nothing applies (no version is produced). */
  newVersion: string | null;
  items: string[];
  /** Either a suggestion that must still be `applying` with this attempt, or a draft revision. */
  suggestionId?: string;
  draft?: { userId: string; revision: number };
}

const claimed = "exists (select 1 from acceptance_claims where attempt = ? and run_token = ?)";

/** Runs the acceptance as one transaction; returns whether this run's claim was taken. */
export function runAcceptance(db: DatabaseSync, input: Acceptance): boolean {
  const { attempt, runToken, artifactId } = input;
  const owner = input.suggestionId
    ? {
        sql: "exists (select 1 from suggestions where id = ? and state = 'applying' and attempt = ?)",
        args: [input.suggestionId, attempt],
      }
    : {
        sql: "exists (select 1 from drafts where artifact_id = ? and user_id = ? and revision = ?)",
        args: [artifactId, input.draft?.userId ?? "", input.draft?.revision ?? -1],
      };
  db.exec("begin");
  try {
    // 1. The claim: room for every item, the owner still as confirmed, and the base version.
    db.prepare(
      `insert or ignore into acceptance_claims (attempt, run_token, artifact_id)
       select ?, ?, ? where (select count(*) from change_items where artifact_id = ? and state = 'open') + ? <= ?
       and ${owner.sql}
       and exists (select 1 from artifacts where id = ? and current_version = ?)`,
    ).run(
      attempt,
      runToken,
      artifactId,
      artifactId,
      input.items.length,
      CHANGE_LIST_CAP,
      ...owner.args,
      artifactId,
      input.baseVersion,
    );
    // 2. The publication's switch (absent when nothing applies).
    if (input.newVersion !== null) {
      db.prepare(
        `update artifacts set current_version = ? where id = ? and current_version = ? and ${claimed}`,
      ).run(input.newVersion, artifactId, input.baseVersion, attempt, runToken);
    }
    // 3. Every listed item.
    for (const envelope of input.items) {
      db.prepare(
        `insert into change_items (artifact_id, state, envelope) select ?, 'open', ? where ${claimed}`,
      ).run(artifactId, envelope, attempt, runToken);
    }
    // 4. Completion: the suggestion accepted, or the draft deleted, exactly once.
    if (input.suggestionId) {
      db.prepare(
        `update suggestions set state = 'accepted' where id = ? and state = 'applying' and ${claimed}`,
      ).run(input.suggestionId, attempt, runToken);
    } else if (input.draft) {
      db.prepare(
        `delete from drafts where artifact_id = ? and user_id = ? and revision = ? and ${claimed}`,
      ).run(artifactId, input.draft.userId, input.draft.revision, attempt, runToken);
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  const row = db
    .prepare("select run_token from acceptance_claims where attempt = ?")
    .get(attempt) as { run_token: string } | undefined;
  return row?.run_token === runToken;
}
