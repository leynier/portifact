// Content search (premium plan T8, feature `contentSearch`, decision 0012). The index is derived
// data in the owner's regional database: `search_artifacts` and `search_chunks` (Drizzle) and the
// FTS5 table `search_text` (raw SQL in the content_search migration). Only the `search_index`
// outbox job writes it, for the version a commit, rollback, restore or transfer made current; the
// scheduled scans index what a job missed and drop what a plan no longer covers. Triggers drop an
// artifact's rows when it stops being active or changes owner, and the foreign keys when it goes.
import { SEARCH_LIMITS, SearchIndexPayload, type SearchSnippet } from "@portifact/contracts";
import { type Db, hitRateLimit, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  authorize,
  buildMatchExpression,
  CONTENT_SEARCH_FEATURE,
  chunkText,
  type Entitlements,
  entitlements,
  fail,
  hasFeature,
  indexText,
  MARK_CLOSE,
  MARK_OPEN,
  ok,
  ownerMatch,
  ownerToken,
  parseSnippet,
  type Result,
  requireFeature,
  segmentText,
  versionRetention,
} from "@portifact/domain";
import { and, asc, desc, eq, getTableColumns, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  activityColumns,
  decodeCursor,
  encodeCursor,
  type ListedArtifact,
  reachConditions,
  withActivity,
} from "./artifacts.ts";
import { cursorFor, saveCursor } from "./maintenance-cursors.ts";
import type { JobOutcome } from "./outbox.ts";
import { ownerEntitlements } from "./plans.ts";

const a = schema.artifacts;
const sa = schema.searchArtifacts;
const sc = schema.searchChunks;
const o = schema.outbox;

/**
 * The FTS5 table, only so a batch can insert into it (raw `db.run` cannot go in a D1 batch). Kept
 * out of packages/db's schema on purpose: drizzle-kit must never try to create it as a table.
 */
const searchText = sqliteTable("search_text", {
  rowid: integer("rowid"),
  owner: text("owner"),
  body: text("body"),
});

/** Tokens of context a snippet shows around the match. */
const SNIPPET_TOKENS = 24;
/** Bytes of JSON one statement carries to the index (D1 caps a value at 2,000,000 bytes). */
const CHUNK_JSON_BYTES = 1_000_000;
const HTML_PAGE = /\.html?$/i;

/** No search job for this artifact is waiting: a scan never writes a second one. */
function noPendingJob(artifactId: SQL | string): SQL {
  return sql`not exists (select 1 from ${o} where ${o.topic} = 'search_index' and ${o.subject} = ${artifactId})`;
}

/**
 * The statement a write adds to its own batch so the version it makes current gets indexed: a
 * `search_index` job on the write's own claim or old-state condition, only when the owner's
 * entitlements, which the caller already loaded, include content search. `versionId` is an ID or
 * a statement that reads it in the same batch.
 */
export function searchIndexJob(
  db: Db,
  input: {
    entitlements: Entitlements;
    artifactId: string;
    versionId: string | SQL;
    condition: SQL;
    now: number;
  },
): BatchItem<"sqlite">[] {
  if (!hasFeature(input.entitlements, CONTENT_SEARCH_FEATURE)) return [];
  // Columns in schema order: id, topic, payload, available, dispatched, attempts, created, subject, generation.
  return [
    db
      .insert(o)
      .select(
        sql`select null, 'search_index', json_object('versionId', ${input.versionId}), ${input.now}, null, 0, ${input.now}, ${input.artifactId}, null where ${input.condition}`,
      ),
  ];
}

interface IndexTarget {
  artifactId: string;
  ownerId: string;
  versionId: string;
}

/** The artifact is still active, of the same owner, with this version current. */
function stillCurrent(target: IndexTarget): SQL {
  return sql`exists (select 1 from ${a} where ${a.id} = ${target.artifactId} and ${a.ownerId} = ${target.ownerId} and ${a.currentVersionId} = ${target.versionId} and ${a.state} = 'active')`;
}

/** The files of a version that hold searchable text, the entrypoint first. */
async function indexableFiles(
  db: Db,
  version: { id: string; entrypoint: string; type: string },
): Promise<{ path: string; r2Key: string; size: number }[]> {
  const vf = schema.versionFiles;
  const rows = await db
    .select({ path: vf.path, r2Key: schema.objects.r2Key, size: vf.size })
    .from(vf)
    .innerJoin(
      schema.objects,
      and(eq(schema.objects.ownerId, vf.ownerId), eq(schema.objects.sha256, vf.sha256)),
    )
    .where(
      and(
        eq(vf.versionId, version.id),
        eq(vf.kind, "published"),
        version.type === "site" ? undefined : eq(vf.path, version.entrypoint),
      ),
    )
    .orderBy(asc(vf.path));
  const pages = version.type === "site" ? rows.filter((row) => HTML_PAGE.test(row.path)) : rows;
  return [
    ...pages.filter((row) => row.path === version.entrypoint),
    ...pages.filter((row) => row.path !== version.entrypoint),
  ];
}

/** One file to read for the index: where its object is and how large it is. */
export interface IndexFileRef {
  path: string;
  r2Key: string;
  size: number;
}

export interface IndexRead {
  files: { path: string; text: string }[];
  /** UTF-8 bytes of the text kept. */
  bytes: number;
  /** Something was left out: a cap, an object missing from R2, or files past the per-version count. */
  partial: boolean;
  /** Index in `files` of the first file a continuation job must read; null when none is left. */
  next: number | null;
  /** Bytes read from R2. */
  readBytes: number;
}

/**
 * Reads the text of a version's files for one job, in order, holding at most `textBudget` bytes of
 * text plus the one object being read: each file's extraction gets the budget left as its
 * maximum, and reading stops when it is spent (the rest is partial) or when the job's R2 budget
 * (`readBudget` bytes, `maxReads` objects) is, leaving the rest to a continuation. An object
 * missing from R2 makes the artifact partial.
 */
export async function readIndexText(
  bucket: R2Bucket,
  files: readonly IndexFileRef[],
  input: {
    html: boolean;
    textBudget: number;
    readBudget: number;
    maxReads: number;
    maxFiles: number;
  },
): Promise<IndexRead> {
  const kept: IndexRead["files"] = [];
  const budget = Math.max(0, input.textBudget);
  let textLeft = budget;
  let readBytes = 0;
  let reads = 0;
  let partial = files.length > input.maxFiles;
  const last = Math.min(files.length, input.maxFiles);
  for (let index = 0; index < last; index++) {
    if (textLeft === 0)
      return { files: kept, bytes: budget - textLeft, partial: true, next: null, readBytes };
    const file = files[index] as IndexFileRef;
    const length = Math.min(file.size, SEARCH_LIMITS.fileReadBytes);
    if (reads > 0 && (reads >= input.maxReads || readBytes + length > input.readBudget)) {
      return { files: kept, bytes: budget - textLeft, partial, next: index, readBytes };
    }
    reads += 1;
    readBytes += length;
    const object = await bucket.get(file.r2Key, length > 0 ? { range: { offset: 0, length } } : {});
    if (!object) {
      partial = true;
      continue;
    }
    const raw = new TextDecoder().decode(await object.arrayBuffer());
    const text = indexText(raw, input.html, Math.min(SEARCH_LIMITS.fileTextBytes, textLeft));
    if (text.cut || file.size > SEARCH_LIMITS.fileReadBytes) partial = true;
    if (text.bytes === 0) continue;
    kept.push({ path: file.path, text: text.text });
    textLeft -= text.bytes;
  }
  return { files: kept, bytes: budget - textLeft, partial, next: null, readBytes };
}

interface ChunkRow {
  path: string;
  seq: number;
  body: string;
}

/** Groups the chunks so each statement's JSON stays under D1's value size. */
function batches(files: ChunkRow[]): string[] {
  const out: string[] = [];
  let current: ChunkRow[] = [];
  let size = 2;
  for (const file of files) {
    const bytes = new TextEncoder().encode(JSON.stringify(file)).length + 1;
    if (current.length > 0 && size + bytes > CHUNK_JSON_BYTES) {
      out.push(JSON.stringify(current));
      current = [];
      size = 2;
    }
    current.push(file);
    size += bytes;
  }
  if (current.length > 0) out.push(JSON.stringify(current));
  return out;
}

/**
 * Runs a `search_index` job. The first job of a version replaces the artifact's rows; when one
 * job's R2 budget (`SEARCH_LIMITS.jobReadBytes`, `jobFiles`) does not cover the version, it writes
 * what it read and a continuation job (`from`, the next file) in the same batch, and each
 * continuation appends while `search_artifacts.next_file` still names its `from`, then moves it
 * on, so a repeated job writes nothing twice. Every write holds only while the version is current
 * and the artifact active with the owner it had, and the owner's total stays under its cap. A job
 * for a version that is no longer current, of an artifact gone or inactive, or of an owner whose
 * plan lost the feature does nothing.
 */
export async function runSearchIndex(
  db: Db,
  bucket: R2Bucket,
  row: { subject: string | null; payload: unknown },
  now: number,
): Promise<JobOutcome> {
  const artifactId = row.subject ?? "";
  const { versionId, from = 0 } = SearchIndexPayload.parse(row.payload);
  const p = schema.ownerPlans;
  const [artifact] = await db
    .select({
      ownerId: a.ownerId,
      type: a.type,
      state: a.state,
      currentVersionId: a.currentVersionId,
      entrypoint: schema.versions.entrypoint,
      plan: { plan: p.plan, seats: p.seats, validUntil: p.validUntil, overrides: p.overrides },
    })
    .from(a)
    .innerJoin(schema.versions, eq(schema.versions.id, versionId))
    .leftJoin(p, eq(p.ownerId, a.ownerId))
    .where(eq(a.id, artifactId))
    .limit(1);
  if (artifact?.state !== "active" || artifact.currentVersionId !== versionId) return "stale";
  if (!hasFeature(entitlements(artifact.plan, now), CONTENT_SEARCH_FEATURE)) return "stale";
  const [indexed] = await db
    .select({ versionId: sa.versionId, nextFile: sa.nextFile, textBytes: sa.textBytes })
    .from(sa)
    .where(eq(sa.artifactId, artifactId))
    .limit(1);
  if (from === 0 && indexed?.versionId === versionId && indexed.nextFile === null) return "done";
  // A continuation acts only on the pass it continues: one restarted or finished is done.
  if (from > 0 && (indexed?.versionId !== versionId || indexed.nextFile !== from)) return "done";
  const soFar = from > 0 ? (indexed?.textBytes ?? 0) : 0;

  const target = { artifactId, ownerId: artifact.ownerId, versionId };
  const files = await indexableFiles(db, {
    id: versionId,
    entrypoint: artifact.entrypoint,
    type: artifact.type,
  });
  const [used] = await db
    .select({ bytes: sql<number>`coalesce(sum(${sa.textBytes}), 0)` })
    .from(sa)
    .where(and(eq(sa.ownerId, artifact.ownerId), sql`${sa.artifactId} <> ${artifactId}`));
  const others = Number(used?.bytes ?? 0);
  const read = await readIndexText(bucket, files.slice(from), {
    html: artifact.type === "site",
    textBudget: Math.min(
      SEARCH_LIMITS.versionTextBytes - soFar,
      SEARCH_LIMITS.ownerTextBytes - others - soFar,
    ),
    readBudget: SEARCH_LIMITS.jobReadBytes,
    maxReads: SEARCH_LIMITS.jobFiles,
    maxFiles: SEARCH_LIMITS.filesPerVersion - from,
  });
  const next = read.next === null ? null : from + read.next;

  const current = stillCurrent(target);
  // The owner's other artifacts and this one stay under the cap, read inside the batch.
  const fits = sql`(select coalesce(sum(${sa.textBytes}), 0) from ${sa} where ${sa.ownerId} = ${artifact.ownerId} and ${sa.artifactId} <> ${artifactId}) + ${soFar + read.bytes} <= ${SEARCH_LIMITS.ownerTextBytes}`;
  // The pass this job writes: the row it inserted, or the one whose next file is its `from`.
  const mine =
    from === 0
      ? sql`exists (select 1 from ${sa} where ${sa.artifactId} = ${artifactId} and ${sa.versionId} = ${versionId} and ${sa.indexedAt} = ${now} and ${sa.textBytes} = ${read.bytes})`
      : sql`exists (select 1 from ${sa} where ${sa.artifactId} = ${artifactId} and ${sa.versionId} = ${versionId} and ${sa.nextFile} = ${from}) and ${fits}`;
  const token = ownerToken(artifact.ownerId);
  const statements: BatchItem<"sqlite">[] =
    from === 0
      ? [
          // Cascades to the chunks and, through their trigger, to the full-text rows.
          db.delete(sa).where(and(eq(sa.artifactId, artifactId), current)),
          db
            .insert(sa)
            // Columns in schema order: artifact, owner, version, text bytes, partial, indexed at, next file.
            .select(
              sql`select ${artifactId}, ${artifact.ownerId}, ${versionId}, ${read.bytes}, ${read.partial ? 1 : 0}, ${now}, ${next} where ${current} and ${fits}`,
            ),
        ]
      : [];
  const rows = read.files.flatMap((file) =>
    chunkText(file.text).map((text, seq) => ({ path: file.path, seq, body: segmentText(text) })),
  );
  const entry = (field: "path" | "seq" | "body") => sql.raw(`json_extract(value, '$.${field}')`);
  for (const json of batches(rows)) {
    statements.push(
      db
        .insert(sc)
        // Columns in schema order: id, artifact, path, seq.
        .select(
          sql`select null, ${artifactId}, ${entry("path")}, ${entry("seq")} from json_each(${json}) where ${mine} and ${current}`,
        ),
      db
        .insert(searchText)
        // Columns in table order: rowid, owner, body.
        .select(
          sql`select ${sc.id}, ${token}, ${entry("body")} from json_each(${json}) join ${sc} on ${sc.artifactId} = ${artifactId} and ${sc.path} = ${entry("path")} and ${sc.seq} = ${entry("seq")} where ${mine} and ${current}`,
        ),
    );
  }
  if (next !== null) {
    statements.push(
      db
        .insert(o)
        .select(
          sql`select null, 'search_index', json_object('versionId', ${versionId}, 'from', ${next}), ${now}, null, 0, ${now}, ${artifactId}, null where ${mine} and ${current}`,
        ),
    );
  }
  if (from > 0) {
    // Last, on the old next file, so the writes above saw the pass they continue.
    statements.push(
      db
        .update(sa)
        .set({
          textBytes: sql`${sa.textBytes} + ${read.bytes}`,
          partial: sql`${sa.partial} or ${read.partial ? 1 : 0}`,
          nextFile: next,
        })
        .where(and(eq(sa.artifactId, artifactId), eq(sa.nextFile, from), current, fits)),
    );
  }
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  const [written] = await db
    .select({ versionId: sa.versionId, nextFile: sa.nextFile })
    .from(sa)
    .where(eq(sa.artifactId, artifactId))
    .limit(1);
  if (written?.versionId === versionId && written.nextFile === next) return "done";
  // Not current any more, or another artifact of the owner took the room meanwhile: a later run
  // (the scan) computes the budget again.
  return (await db.select({ id: a.id }).from(a).where(current).limit(1)).length > 0
    ? "pending"
    : "stale";
}

/** Rows of the owner-plan walk and the lapsed-index walk read per run. */
const OWNER_PAGE = 100;
const SCHEDULE_CURSOR = "search_index_schedule";
const DROP_CURSOR = "search_index_drop";

/**
 * The safety net for indexing (and a plan gained later, a restore, a reinstatement or a lost
 * continuation): one page of `owner_plans` per run, from a cursor kept in `maintenance_cursors`,
 * and one statement that writes a `search_index` job for up to `limit` active artifacts of that
 * page's entitled owners whose current version is not fully indexed and that have no job waiting.
 * Four queries a run whatever the number of owners; a page that still had more due is read again
 * next run.
 */
export async function scheduleSearchIndexing(
  db: Db,
  now: number,
  limit: number = SEARCH_LIMITS.scanJobs,
): Promise<{ scheduled: number }> {
  const p = schema.ownerPlans;
  const after = await cursorFor(db, SCHEDULE_CURSOR);
  const page = await db
    .select({
      ownerId: p.ownerId,
      plan: p.plan,
      seats: p.seats,
      validUntil: p.validUntil,
      overrides: p.overrides,
    })
    .from(p)
    .where(sql`${p.ownerId} > ${after}`)
    .orderBy(asc(p.ownerId))
    .limit(OWNER_PAGE);
  const owners = page
    .filter((row) => hasFeature(entitlements(row, now), CONTENT_SEARCH_FEATURE))
    .map((row) => row.ownerId);
  let scheduled = 0;
  if (owners.length > 0) {
    const due = sql`${a.ownerId} in (select value from json_each(${JSON.stringify(owners)})) and ${a.state} = 'active' and ${a.currentVersionId} is not null and not exists (select 1 from ${sa} where ${sa.artifactId} = ${a.id} and ${sa.versionId} = ${a.currentVersionId} and ${sa.nextFile} is null) and ${noPendingJob(sql`${a.id}`)}`;
    scheduled = (
      await db
        .insert(o)
        .select(
          sql`select null, 'search_index', json_object('versionId', ${a.currentVersionId}), ${now}, null, 0, ${now}, ${a.id}, null from ${a} where ${due} order by ${a.id} limit ${limit}`,
        )
        .returning({ id: o.id })
    ).length;
  }
  const next =
    scheduled >= limit ? after : page.length < OWNER_PAGE ? "" : (page.at(-1)?.ownerId ?? "");
  if (next !== after) await saveCursor(db, SCHEDULE_CURSOR, next, now);
  return { scheduled };
}

/**
 * Drops the index of owners whose plan no longer includes content search: one page of indexed
 * owners per run from a cursor, and one statement that deletes up to `limit` of their indexed
 * artifacts, each owner's only while its plan row is the one read (a plan granted meanwhile keeps
 * them). Four queries a run; a page with more to drop is read again next run.
 */
export async function dropLapsedSearchIndexes(
  db: Db,
  now: number,
  limit: number = SEARCH_LIMITS.dropArtifacts,
): Promise<{ dropped: number }> {
  const p = schema.ownerPlans;
  const after = await cursorFor(db, DROP_CURSOR);
  const owners = (
    await db
      .selectDistinct({ ownerId: sa.ownerId })
      .from(sa)
      .where(sql`${sa.ownerId} > ${after}`)
      .orderBy(asc(sa.ownerId))
      .limit(OWNER_PAGE)
  ).map((row) => row.ownerId);
  const plans = new Map(
    owners.length === 0
      ? []
      : (
          await db
            .select({
              ownerId: p.ownerId,
              plan: p.plan,
              seats: p.seats,
              validUntil: p.validUntil,
              overrides: p.overrides,
              updatedAt: p.updatedAt,
            })
            .from(p)
            .where(inArray(p.ownerId, owners))
        ).map((row) => [row.ownerId, row]),
  );
  // Each lapsed owner with the plan row read: its `updated_at`, or null for no row.
  const lapsed = owners
    .filter(
      (owner) => !hasFeature(entitlements(plans.get(owner) ?? null, now), CONTENT_SEARCH_FEATURE),
    )
    .map((owner) => [owner, plans.get(owner)?.updatedAt ?? null]);
  let dropped = 0;
  if (lapsed.length > 0) {
    const unchanged = sql`exists (select 1 from json_each(${JSON.stringify(lapsed)}) as lapsed where json_extract(lapsed.value, '$[0]') = ${sa.ownerId} and (case when json_extract(lapsed.value, '$[1]') is null then not exists (select 1 from ${p} where ${p.ownerId} = ${sa.ownerId}) else exists (select 1 from ${p} where ${p.ownerId} = ${sa.ownerId} and ${p.updatedAt} = json_extract(lapsed.value, '$[1]')) end))`;
    dropped = (
      await db
        .delete(sa)
        .where(
          sql`${sa.artifactId} in (select ${sa.artifactId} from ${sa} where ${unchanged} order by ${sa.artifactId} limit ${limit})`,
        )
        .returning({ id: sa.artifactId })
    ).length;
  }
  const next = dropped >= limit ? after : owners.length < OWNER_PAGE ? "" : (owners.at(-1) ?? "");
  if (next !== after) await saveCursor(db, DROP_CURSOR, next, now);
  return { dropped };
}

export interface SearchInput {
  /** The actor on the space searched, from `resolveOwnerScope`. */
  actor: Actor;
  query: string;
  cursor?: string | undefined;
  limit: number;
  now: number;
}

export type SearchHit = {
  artifact: ListedArtifact;
  path: string;
  snippet: SearchSnippet;
  partial: boolean;
};

export interface SearchPage {
  items: SearchHit[];
  nextCursor: string | null;
}

/** The match and how far the actor reaches, decided before any full-text work. */
interface SearchPlan {
  actor: Actor;
  match: string;
  after: { updatedAt: number; id: string } | undefined;
  limit: number;
  now: number;
  retention: ReturnType<typeof versionRetention>;
}

/**
 * The chunk IDs a restricted service token reaches (decision 0011: its own artifacts, or those
 * whose publish key has its prefix), as a subquery on its own aliases; null for everyone else.
 */
function reachableChunks(actor: Actor): SQL | null {
  const restriction = actor.token?.restriction;
  if (!restriction || restriction.kind === "none") return null;
  const reach =
    restriction.kind === "own"
      ? sql`"reach_artifact"."created_by" = ${actor.userId}`
      : // substr, not like: `_` and `%` are allowed in keys and would be wildcards.
        sql`substr("reach_artifact"."external_key", 1, ${restriction.prefix.length}) = ${restriction.prefix}`;
  return sql`select "reach_chunk"."id" from ${sc} as "reach_chunk" join ${a} as "reach_artifact" on "reach_artifact"."id" = "reach_chunk"."artifact_id" where "reach_artifact"."owner_id" = ${actor.ownerId} and "reach_artifact"."state" = 'active' and ${reach}`;
}

/**
 * The page of artifacts whose text matches, with their best chunk. For a restricted token the
 * full-text table is read only at the chunk IDs it reaches (FTS5 answers a MATCH with a rowid
 * constraint row by row), so rows outside its reach cost nothing and the time a search takes
 * says nothing about them. Exported for the tests that measure the rows it reads.
 */
export function searchPageQuery(db: Db, plan: SearchPlan) {
  const reachable = reachableChunks(plan.actor);
  // The best chunk of each matching artifact: SQLite takes the bare columns from the row of min().
  const best = db
    .select({
      artifactId: sql<string>`${sc.artifactId}`.as("hit_artifact_id"),
      chunkId: sql<number>`${sc.id}`.as("hit_chunk_id"),
      path: sql<string>`${sc.path}`.as("hit_path"),
      rank: sql<number>`min(search_text.rank)`.as("hit_rank"),
    })
    .from(sql`search_text`)
    .innerJoin(sc, sql`${sc.id} = search_text.rowid`)
    .where(
      and(
        sql`search_text match ${plan.match}`,
        reachable ? sql`search_text.rowid in (${reachable})` : undefined,
      ),
    )
    .groupBy(sc.artifactId)
    .as("hits");
  const { after } = plan;
  return db
    .select({
      ...getTableColumns(a),
      ...activityColumns(plan.retention, plan.now),
      hitChunkId: best.chunkId,
      hitPath: best.path,
      partial: sa.partial,
    })
    .from(a)
    .innerJoin(best, eq(best.artifactId, a.id))
    .innerJoin(sa, eq(sa.artifactId, a.id))
    .where(
      and(
        eq(a.ownerId, plan.actor.ownerId),
        eq(a.state, "active"),
        reachConditions(plan.actor),
        after
          ? or(
              lt(a.updatedAt, after.updatedAt),
              and(eq(a.updatedAt, after.updatedAt), lt(a.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(a.updatedAt), desc(a.id))
    .limit(plan.limit + 1);
}

/**
 * Searches the text of the current versions of the actor's owner's active artifacts. Only an
 * admin or editor of the owner (or a service token, within its reach) may, on a plan with
 * content search, and within the per-actor and per-owner rate limits. A query with more words
 * than `SEARCH_LIMITS` allows is `invalid_input`. One result per artifact (its best chunk), most
 * recently updated first with the artifact list's cursor; the snippet is plain text with
 * highlight ranges. A query with nothing to search for finds nothing.
 */
export async function searchContent(
  db: RegionalDb,
  input: SearchInput,
): Promise<Result<SearchPage>> {
  const allowed = authorize(input.actor, "search");
  if (!allowed.ok) return allowed;
  const owner = await ownerEntitlements(db, input.actor.ownerId, input.now);
  const gated = requireFeature(owner, CONTENT_SEARCH_FEATURE);
  if (!gated.ok) return gated;
  const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (input.cursor !== undefined && !after) return fail("invalid_input", "Invalid cursor.");
  const expression = buildMatchExpression(input.query);
  if (!expression.ok) return expression;
  // In the global database, with the other counters, whose pruning covers them. The owner's
  // counter bounds the work one space puts on its region, whoever searches.
  const windowMs = SEARCH_LIMITS.windowSeconds * 1000;
  const counters: [string, number][] = [
    [`search:${input.actor.userId}`, SEARCH_LIMITS.perWindow],
    [`search-owner:${input.actor.ownerId}`, SEARCH_LIMITS.perOwnerWindow],
  ];
  for (const [key, max] of counters) {
    const hit = await hitRateLimit(db.global.$client, key, windowMs, input.now);
    if (hit.count > max) {
      return fail("rate_limited", "Too many searches. Wait a minute and try again.");
    }
  }
  if (expression.value === null) return ok({ items: [], nextCursor: null });
  const match = ownerMatch(input.actor.ownerId, expression.value);
  const rows = await searchPageQuery(db, {
    actor: input.actor,
    match,
    after,
    limit: input.limit,
    now: input.now,
    retention: versionRetention(owner.limits),
  });
  const page = rows.slice(0, input.limit);
  const snippets = await snippetsFor(
    db,
    match,
    page.map((row) => Number(row.hitChunkId)),
  );
  const artifacts = await withActivity(
    db,
    page.map(({ hitChunkId: _chunk, hitPath: _path, partial: _partial, ...row }) => row),
  );
  const items = page.map(({ hitChunkId, hitPath, partial }, index) => ({
    artifact: artifacts[index] as ListedArtifact,
    path: hitPath,
    snippet: snippets.get(Number(hitChunkId)) ?? { text: "", highlights: [] },
    partial,
  }));
  const last = page.at(-1);
  return ok({ items, nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null });
}

async function snippetsFor(
  db: Db,
  match: string,
  chunkIds: number[],
): Promise<Map<number, SearchSnippet>> {
  if (chunkIds.length === 0) return new Map();
  const rows = await db.all<{ id: number; marked: string }>(
    sql`select rowid as id, snippet(search_text, 1, ${MARK_OPEN}, ${MARK_CLOSE}, '…', ${SNIPPET_TOKENS}) as marked from search_text where search_text match ${match} and rowid in (select value from json_each(${JSON.stringify(chunkIds)}))`,
  );
  return new Map(rows.map((row) => [Number(row.id), parseSnippet(row.marked)]));
}
