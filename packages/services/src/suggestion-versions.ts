// What a new current version does to suggestions and the change list (decision 0027,
// "Suggestions and new versions", "Closing by itself"). Every switch of the current version (a
// publish, an accepted suggestion or draft, a rollback) writes, in its own batch and on its own
// switch condition, a `suggestion_carry` job when the artifact has pending suggestions and a
// `change_list_check` job when it has open items with proof data. Restoring an archived artifact
// changes no version and writes neither.
//
// - The carry job moves a pending suggestion to the current version only by a verified relocation
//   (`carryAll` with the inputs the domain requires: the old and new file, eligibility before and
//   after, and whether every other file of the version is unchanged), keeping its edit and
//   rewriting its proofs; any other pending suggestion becomes `outdated` and stays on its version.
// - The check job closes an open text item (`closed_by_version`) only with a proof on the current
//   version's rendered page (`closure`).
//
// Both are idempotent under at-least-once delivery: each write is conditioned on the state it
// read (the suggestion's revision and version, the item's revision and state) and on the version
// still being current; a job for a version that is no longer current does nothing, since the
// switch that replaced it wrote its own. Each run handles at most `SUGGESTION_LIMITS.itemsPerCheck`
// suggestions or items and writes the next job in its last batch when more are left.
import {
  CHANGE_LIST_LIMITS,
  type FileKind,
  utf8Length,
  type Proof,
  SUGGESTION_LIMITS,
  VersionJobPayload,
} from "@portifact/contracts";
import { type Db, type RegionalDb, schema } from "@portifact/db";
import {
  type Carriable,
  type Carry,
  carriedProofs,
  carryAll,
  carryRequest,
  closure,
  htmlEligibility,
  newWork,
  renderedPage,
} from "@portifact/domain/suggestions";
import { DOCUMENT_RENDERER } from "@portifact/render";
import { and, asc, eq, gt, ne, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { JobOutcome } from "./outbox.ts";
import { type StoredPage, storedPage } from "./suggestion-plans.ts";
import { storedEdit, storedProofs } from "./suggestions.ts";

const th = schema.annotationThreads;
const ci = schema.changeItems;
const t = schema.artifacts;

type OutboxRow = typeof schema.outbox.$inferSelect;
type ArtifactRow = typeof schema.artifacts.$inferSelect;
type ThreadRow = typeof th.$inferSelect;

/** A version job, written only when `condition` and `when` hold. */
function versionJob(
  db: Db,
  topic: "suggestion_carry" | "change_list_check",
  input: { artifactId: string; versionId: string; after?: string; condition: SQL; now: number },
  when: SQL,
): BatchItem<"sqlite"> {
  const payload = JSON.stringify({
    versionId: input.versionId,
    ...(input.after === undefined ? {} : { after: input.after }),
  });
  // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
  // subject, generation.
  return db
    .insert(schema.outbox)
    .select(
      sql`select null, ${topic}, ${payload}, ${input.now}, null, 0, ${input.now}, ${input.artifactId}, null where ${input.condition} and ${when}`,
    );
}

const pendingSuggestions = (artifactId: string) =>
  sql`exists (select 1 from ${th} where ${th.artifactId} = ${artifactId} and ${th.kind} = 'suggestion' and ${th.suggestionState} = 'pending')`;

const checkableItems = (artifactId: string) =>
  sql`exists (select 1 from ${ci} where ${ci.artifactId} = ${artifactId} and ${ci.state} = 'open' and ${ci.proof} is not null)`;

/**
 * The jobs a switch to `versionId` owes the artifact's suggestions and change list, each written
 * only when there is something for it, on the switch's own condition.
 */
export function suggestionVersionJobs(
  db: Db,
  input: { artifactId: string; versionId: string; condition: SQL; now: number },
): BatchItem<"sqlite">[] {
  return [
    versionJob(db, "suggestion_carry", input, pendingSuggestions(input.artifactId)),
    versionJob(db, "change_list_check", input, checkableItems(input.artifactId)),
  ];
}

/** The artifact a version job is about, while that version is still its current one. */
async function currentArtifact(
  db: RegionalDb,
  row: OutboxRow,
): Promise<{ artifact: ArtifactRow; versionId: string } | null> {
  const payload = VersionJobPayload.safeParse(row.payload);
  if (!payload.success || row.subject === null) return null;
  const [artifact] = await db.select().from(t).where(eq(t.id, row.subject)).limit(1);
  if (!artifact || artifact.currentVersionId !== payload.data.versionId) return null;
  if (artifact.state !== "active") return null;
  return { artifact, versionId: payload.data.versionId };
}

/** The current version's file list (published files), to tell whether other files changed. */
async function publishedFiles(db: RegionalDb, versionId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ path: schema.versionFiles.path, sha256: schema.versionFiles.sha256 })
    .from(schema.versionFiles)
    .where(
      and(eq(schema.versionFiles.versionId, versionId), eq(schema.versionFiles.kind, "published")),
    );
  return new Map(rows.map((row) => [row.path, row.sha256]));
}

function otherFilesUnchanged(
  before: Map<string, string>,
  after: Map<string, string>,
  path: string,
): boolean {
  if (before.size !== after.size) return false;
  for (const [file, sha256] of before) {
    if (file !== path && after.get(file) !== sha256) return false;
  }
  return true;
}

const pageOptions = (artifact: ArtifactRow, page: StoredPage) => ({
  title: artifact.name,
  pageUrl: page.pageUrl,
  renderer: DOCUMENT_RENDERER,
});

/** The carry of one group of suggestions on one old version and path. */
async function carryGroup(
  db: RegionalDb,
  bucket: R2Bucket,
  artifact: ArtifactRow,
  versionId: string,
  contentDomain: string,
  threads: ThreadRow[],
): Promise<{ outcome: Map<string, ReturnType<typeof carriedProofs>>; bytes: number }> {
  const outcome = new Map<string, ReturnType<typeof carriedProofs>>();
  let bytes = 0;
  const done = () => ({ outcome, bytes });
  const first = threads[0] as ThreadRow;
  const outdate = (reason: "not_on_page" | "not_planned" | "not_eligible") => {
    for (const thread of threads) outcome.set(thread.id, { outdated: reason });
    return done();
  };
  const read = { artifact, path: first.path, contentDomain };
  const [before, after] = [
    await storedPage(db, bucket, { ...read, versionId: first.versionId }),
    await storedPage(db, bucket, { ...read, versionId }),
  ];
  for (const page of [before, after]) bytes += page.ok ? utf8Length(page.value.source) : 0;
  if (!after.ok) return outdate("not_on_page");
  if (!before.ok || !before.value.decoded || !after.value.decoded) return outdate("not_eligible");
  const requests: { thread: ThreadRow; from: number; count: number }[] = [];
  const items: Carriable[] = [];
  for (const thread of threads) {
    const edit = storedEdit(thread);
    const request = edit
      ? carryRequest(edit, storedProofs(thread), thread.versionId)
      : ({ outdated: "not_planned" } as const);
    if ("outdated" in request) {
      outcome.set(thread.id, request);
      continue;
    }
    requests.push({ thread, from: items.length, count: request.items.length });
    items.push(...request.items);
  }
  if (items.length === 0) return done();
  const unchanged = otherFilesUnchanged(
    await publishedFiles(db, first.versionId),
    await publishedFiles(db, versionId),
    first.path,
  );
  // One marked and one unmarked render for the whole group (decision 0027, "Budget").
  const results = carryAll(after.value.kind, before.value.source, after.value.source, items, {
    ...pageOptions(artifact, after.value),
    otherFilesUnchanged: unchanged,
    work: newWork(),
  });
  for (const request of requests) {
    const own: Carry[] = results.slice(request.from, request.from + request.count);
    outcome.set(request.thread.id, carriedProofs(own, versionId));
  }
  return done();
}

/**
 * Carries the artifact's pending suggestions to its current version, or outdates them: one run
 * takes at most `itemsPerCheck` suggestions, oldest first, and writes the next job when more wait.
 */
export async function runSuggestionCarry(
  db: RegionalDb,
  bucket: R2Bucket,
  row: OutboxRow,
  now: number,
  contentDomain: string,
  limit: number = SUGGESTION_LIMITS.itemsPerCheck,
  readBytes: number = SUGGESTION_LIMITS.jobReadBytes,
): Promise<JobOutcome> {
  const current = await currentArtifact(db, row);
  if (!current) return "stale";
  const { artifact, versionId } = current;
  const threads = await db
    .select()
    .from(th)
    .where(
      and(
        eq(th.artifactId, artifact.id),
        eq(th.kind, "suggestion"),
        eq(th.suggestionState, "pending"),
        ne(th.versionId, versionId),
      ),
    )
    .orderBy(asc(th.createdAt), asc(th.id))
    .limit(limit + 1);
  if (threads.length === 0) return "done";
  const batch = threads.slice(0, limit);
  const groups = new Map<string, ThreadRow[]>();
  for (const thread of batch) {
    const key = JSON.stringify([thread.versionId, thread.path]);
    groups.set(key, [...(groups.get(key) ?? []), thread]);
  }
  const switchedHere = sql`exists (select 1 from ${t} where ${t.id} = ${artifact.id} and ${t.currentVersionId} = ${versionId})`;
  const statements: BatchItem<"sqlite">[] = [];
  let spent = 0;
  let stopped = false;
  for (const group of groups.values()) {
    // At most `readBytes` of stored files per run, one group's two pages held at a time; the
    // groups left wait, untouched, for the next job.
    if (spent >= readBytes) {
      stopped = true;
      break;
    }
    const carried = await carryGroup(db, bucket, artifact, versionId, contentDomain, group);
    spent += carried.bytes;
    const outcome = carried.outcome;
    for (const thread of group) {
      // Every thread of the group has an outcome.
      const result = outcome.get(thread.id) as ReturnType<typeof carriedProofs>;
      const same = and(
        eq(th.id, thread.id),
        eq(th.suggestionState, "pending"),
        eq(th.versionId, thread.versionId),
        eq(th.suggestionRevision, thread.suggestionRevision),
        switchedHere,
      );
      statements.push(
        "outdated" in result
          ? db
              .update(th)
              .set({
                suggestionState: "outdated",
                attemptReason: null,
                suggestionRevision: sql`${th.suggestionRevision} + 1`,
                updatedAt: now,
              })
              .where(same)
          : db
              .update(th)
              .set({
                versionId,
                editProofs: JSON.stringify(result),
                originVersionId: sql`coalesce(${th.originVersionId}, ${thread.versionId})`,
                originTarget: sql`coalesce(${th.originTarget}, ${th.target})`,
                suggestionRevision: sql`${th.suggestionRevision} + 1`,
                updatedAt: now,
              })
              .where(same),
      );
    }
  }
  if (threads.length > limit || stopped) {
    statements.push(
      versionJob(
        db,
        "suggestion_carry",
        { artifactId: artifact.id, versionId, condition: switchedHere, now },
        sql`1`,
      ),
    );
  }
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  return "done";
}

/**
 * The rendered page a closure is proved on, or null: a page that could not be read, or an HTML
 * page over the node budget (`htmlEligibility` counts the whole page first), proves nothing.
 */
function closurePage(artifact: ArtifactRow, page: StoredPage) {
  if (!page.decoded) return null;
  const work = newWork();
  if (page.kind === "html" && htmlEligibility(page.source, work) === "too_large") return null;
  return renderedPage(page.kind as FileKind, page.source, { ...pageOptions(artifact, page), work });
}

/** The proof of an item, or null when it has none or it cannot be read. */
function itemProof(text: string | null): Proof | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as Proof;
  } catch {
    return null;
  }
}

/**
 * Closes the artifact's open text items whose change its current version's page shows, by the
 * proof each item persisted. Pages are rendered once per path; at most `itemsPerCheck` items per
 * run, resuming after the last item checked.
 */
export async function runChangeListCheck(
  db: RegionalDb,
  bucket: R2Bucket,
  row: OutboxRow,
  now: number,
  contentDomain: string,
  limit: number = SUGGESTION_LIMITS.itemsPerCheck,
  readBytes: number = SUGGESTION_LIMITS.jobReadBytes,
): Promise<JobOutcome> {
  const current = await currentArtifact(db, row);
  if (!current) return "stale";
  const { artifact, versionId } = current;
  const after = VersionJobPayload.parse(row.payload).after;
  const items = await db
    .select({ id: ci.id, path: ci.path, proof: ci.proof, revision: ci.revision })
    .from(ci)
    .where(
      and(
        eq(ci.artifactId, artifact.id),
        eq(ci.state, "open"),
        sql`${ci.proof} is not null`,
        ...(after === undefined ? [] : [gt(ci.id, after)]),
      ),
    )
    .orderBy(asc(ci.id))
    .limit(limit + 1);
  if (items.length === 0) return "done";
  const batch = items.slice(0, limit);
  // One page held at a time (items of one path in a row reuse it), and at most `readBytes` of
  // stored files read per run: the rest continues in the next job.
  let heldPath: string | null = null;
  let heldPage: ReturnType<typeof renderedPage> | null = null;
  let spent = 0;
  let checked = 0;
  const closing: { id: string; revision: number }[] = [];
  for (const item of batch) {
    if (heldPath !== item.path) {
      if (spent >= readBytes) break;
      const read = await storedPage(db, bucket, {
        artifact,
        versionId,
        path: item.path,
        contentDomain,
      });
      spent += read.ok ? utf8Length(read.value.source) : 0;
      heldPath = item.path;
      heldPage = read.ok ? closurePage(artifact, read.value) : null;
    }
    checked++;
    const proof = itemProof(item.proof);
    if (proof && heldPage && closure(proof, heldPage).state === "closed") {
      closing.push({ id: item.id, revision: item.revision });
    }
  }
  const switchedHere = sql`exists (select 1 from ${t} where ${t.id} = ${artifact.id} and ${t.currentVersionId} = ${versionId})`;
  const statements: BatchItem<"sqlite">[] = closing.map((item) =>
    db
      .update(ci)
      .set({
        state: "closed_by_version",
        closedAt: now,
        closedBy: null,
        closedVersionId: versionId,
        revision: sql`${ci.revision} + 1`,
      })
      .where(
        and(eq(ci.id, item.id), eq(ci.state, "open"), eq(ci.revision, item.revision), switchedHere),
      ),
  );
  if (items.length > limit || checked < batch.length) {
    const last = checked === 0 ? after : (batch[checked - 1] as { id: string }).id;
    statements.push(
      versionJob(
        db,
        "change_list_check",
        {
          artifactId: artifact.id,
          versionId,
          ...(last === undefined ? {} : { after: last }),
          condition: switchedHere,
          now,
        },
        sql`1`,
      ),
    );
  }
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  return "done";
}

/** Items still open on an artifact, for the acceptance claim's room and the cap's backstop. */
export const openItemsSql = (artifactId: string) =>
  sql`(select count(*) from ${ci} where ${ci.artifactId} = ${artifactId} and ${ci.state} = 'open')`;

export const CHANGE_LIST_CAP = CHANGE_LIST_LIMITS.openPerArtifact;
