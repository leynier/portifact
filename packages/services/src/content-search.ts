// Content search (premium plan T8, feature `contentSearch`, decision 0012). The index is derived
// data in the owner's regional database: `search_artifacts` and `search_files` (Drizzle) and the
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
  cleanText,
  type Entitlements,
  type ExtractedFile,
  entitlements,
  fail,
  hasFeature,
  htmlText,
  MARK_CLOSE,
  MARK_OPEN,
  ok,
  ownerMatch,
  ownerToken,
  parseSnippet,
  planIndex,
  type Result,
  requireFeature,
  segmentText,
  versionRetention,
} from "@portifact/domain";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
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

/** Reads at most the per-file cap of an object and extracts its text. */
async function extractFile(
  bucket: R2Bucket,
  file: { path: string; r2Key: string; size: number },
  html: boolean,
): Promise<ExtractedFile | null> {
  const length = Math.min(file.size, SEARCH_LIMITS.fileReadBytes);
  const object = await bucket.get(file.r2Key, length > 0 ? { range: { offset: 0, length } } : {});
  if (!object) return null;
  const raw = new TextDecoder().decode(await object.arrayBuffer());
  const read = file.size > SEARCH_LIMITS.fileReadBytes;
  if (!html) return { path: file.path, text: cleanText(raw), truncated: read };
  // Characters, a bound above the bytes the plan keeps; planIndex cuts by bytes after.
  const extracted = htmlText(raw, SEARCH_LIMITS.fileTextBytes);
  return {
    path: file.path,
    text: cleanText(extracted.text),
    truncated: read || extracted.truncated,
  };
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
    const json = JSON.stringify(file);
    const bytes = new TextEncoder().encode(json).length + 1;
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
 * Runs a `search_index` job: replaces the artifact's rows with the text of the version the job
 * names, in one batch conditioned on that version still being current and the artifact active
 * with the owner it had, and on the owner's total staying under its cap. A job for a version that
 * is no longer current, of an artifact gone or inactive, or of an owner whose plan lost the
 * feature does nothing; one whose version is already indexed is done.
 */
export async function runSearchIndex(
  db: Db,
  bucket: R2Bucket,
  row: { subject: string | null; payload: unknown },
  now: number,
): Promise<JobOutcome> {
  const artifactId = row.subject ?? "";
  const { versionId } = SearchIndexPayload.parse(row.payload);
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
  if (!artifact || artifact.state !== "active" || artifact.currentVersionId !== versionId) {
    return "stale";
  }
  if (!hasFeature(entitlements(artifact.plan, now), CONTENT_SEARCH_FEATURE)) return "stale";
  const [indexed] = await db
    .select({ versionId: sa.versionId })
    .from(sa)
    .where(eq(sa.artifactId, artifactId))
    .limit(1);
  if (indexed?.versionId === versionId) return "done";

  const target = { artifactId, ownerId: artifact.ownerId, versionId };
  const files = await indexableFiles(db, {
    id: versionId,
    entrypoint: artifact.entrypoint,
    type: artifact.type,
  });
  const extracted: ExtractedFile[] = [];
  for (const file of files.slice(0, SEARCH_LIMITS.filesPerVersion)) {
    const text = await extractFile(bucket, file, artifact.type === "site");
    if (text) extracted.push(text);
  }
  const extraFiles = files.slice(SEARCH_LIMITS.filesPerVersion).map((file) => ({
    path: file.path,
    text: "",
    truncated: false,
  }));
  const [used] = await db
    .select({ bytes: sql<number>`coalesce(sum(${sa.textBytes}), 0)` })
    .from(sa)
    .where(and(eq(sa.ownerId, artifact.ownerId), sql`${sa.artifactId} <> ${artifactId}`));
  const plan = planIndex(
    [...extracted, ...extraFiles],
    SEARCH_LIMITS.ownerTextBytes - Number(used?.bytes ?? 0),
  );

  const current = stillCurrent(target);
  // The owner's other artifacts and this one stay under the cap, read inside the batch.
  const fits = sql`(select coalesce(sum(${sa.textBytes}), 0) from ${sa} where ${sa.ownerId} = ${artifact.ownerId} and ${sa.artifactId} <> ${artifactId}) + ${plan.bytes} <= ${SEARCH_LIMITS.ownerTextBytes}`;
  const mine = sql`exists (select 1 from ${sa} where ${sa.artifactId} = ${artifactId} and ${sa.versionId} = ${versionId})`;
  const token = ownerToken(artifact.ownerId);
  const statements: BatchItem<"sqlite">[] = [
    // Cascades to the chunks and, through their trigger, to the full-text rows.
    db.delete(sa).where(and(eq(sa.artifactId, artifactId), current)),
    db
      .insert(sa)
      // Columns in schema order: artifact, owner, version, text bytes, partial, indexed at.
      .select(
        sql`select ${artifactId}, ${artifact.ownerId}, ${versionId}, ${plan.bytes}, ${plan.partial ? 1 : 0}, ${now} where ${current} and ${fits}`,
      ),
  ];
  const rows = plan.files.flatMap((file) =>
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
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  const [written] = await db
    .select({ versionId: sa.versionId })
    .from(sa)
    .where(eq(sa.artifactId, artifactId))
    .limit(1);
  if (written?.versionId === versionId) return "done";
  // Not current any more, or another artifact of the owner took the room meanwhile: a later run
  // (the scan) computes the budget again.
  return (await db.select({ id: a.id }).from(a).where(current).limit(1)).length > 0
    ? "pending"
    : "stale";
}

/** Plans that grant content search, as stored: the scans read only owners that have one. */
async function entitledOwners(db: Db, now: number, after: string, limit: number) {
  const p = schema.ownerPlans;
  const rows = await db
    .select({
      ownerId: p.ownerId,
      plan: p.plan,
      seats: p.seats,
      validUntil: p.validUntil,
      overrides: p.overrides,
    })
    .from(p)
    .where(gt(p.ownerId, after))
    .orderBy(asc(p.ownerId))
    .limit(limit);
  return {
    last: rows.at(-1)?.ownerId ?? null,
    owners: rows
      .filter((row) => hasFeature(entitlements(row, now), CONTENT_SEARCH_FEATURE))
      .map((row) => row.ownerId),
  };
}

const OWNER_PAGE = 100;

/**
 * The safety net for indexing (and a plan gained later, a restore or a reinstatement): writes a
 * `search_index` job for active artifacts of entitled owners whose current version is not the
 * indexed one and that have no job waiting. At most `limit` jobs a run.
 */
export async function scheduleSearchIndexing(
  db: Db,
  now: number,
  limit = 50,
): Promise<{ scheduled: number }> {
  let scheduled = 0;
  let after = "";
  while (scheduled < limit) {
    const page = await entitledOwners(db, now, after, OWNER_PAGE);
    for (const ownerId of page.owners) {
      if (scheduled >= limit) break;
      const due = sql`${a.ownerId} = ${ownerId} and ${a.state} = 'active' and ${a.currentVersionId} is not null and not exists (select 1 from ${sa} where ${sa.artifactId} = ${a.id} and ${sa.versionId} = ${a.currentVersionId}) and ${noPendingJob(sql`${a.id}`)}`;
      const written = await db
        .insert(o)
        .select(
          sql`select null, 'search_index', json_object('versionId', ${a.currentVersionId}), ${now}, null, 0, ${now}, ${a.id}, null from ${a} where ${due} order by ${a.id} limit ${limit - scheduled}`,
        )
        .returning({ id: o.id });
      scheduled += written.length;
    }
    if (page.last === null) break;
    after = page.last;
  }
  return { scheduled };
}

/**
 * Drops the index of owners whose plan no longer includes content search, at most `limit`
 * artifacts a run, each owner's on the plan row it read (a plan granted meanwhile keeps them).
 */
export async function dropLapsedSearchIndexes(
  db: Db,
  now: number,
  limit = 500,
): Promise<{ dropped: number }> {
  let dropped = 0;
  let after = "";
  while (dropped < limit) {
    const owners = (
      await db
        .selectDistinct({ ownerId: sa.ownerId })
        .from(sa)
        .where(gt(sa.ownerId, after))
        .orderBy(asc(sa.ownerId))
        .limit(OWNER_PAGE)
    ).map((row) => row.ownerId);
    if (owners.length === 0) break;
    after = owners.at(-1) as string;
    const p = schema.ownerPlans;
    const plans = new Map(
      (
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
    for (const ownerId of owners) {
      if (dropped >= limit) break;
      const plan = plans.get(ownerId);
      if (hasFeature(entitlements(plan ?? null, now), CONTENT_SEARCH_FEATURE)) continue;
      const unchanged = plan
        ? sql`exists (select 1 from ${p} where ${p.ownerId} = ${ownerId} and ${p.updatedAt} = ${plan.updatedAt})`
        : sql`not exists (select 1 from ${p} where ${p.ownerId} = ${ownerId})`;
      const gone = await db
        .delete(sa)
        .where(
          sql`${sa.artifactId} in (select ${sa.artifactId} from ${sa} where ${sa.ownerId} = ${ownerId} order by ${sa.artifactId} limit ${limit - dropped}) and ${unchanged}`,
        )
        .returning({ id: sa.artifactId });
      dropped += gone.length;
    }
    if (owners.length < OWNER_PAGE) break;
  }
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

/**
 * Searches the text of the current versions of the actor's owner's active artifacts. Only an
 * admin or editor of the owner (or a service token, within its reach) may, on a plan with
 * content search, and within the per-actor rate limit. One result per artifact (its best file),
 * most recently updated first with the artifact list's cursor; the snippet is plain text with
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
  // In the global database, with the other counters, whose pruning covers it.
  const hit = await hitRateLimit(
    db.global.$client,
    `search:${input.actor.userId}`,
    SEARCH_LIMITS.windowSeconds * 1000,
    input.now,
  );
  if (hit.count > SEARCH_LIMITS.perWindow) {
    return fail("rate_limited", "Too many searches. Wait a minute and try again.");
  }
  const expression = buildMatchExpression(input.query);
  if (expression === null) return ok({ items: [], nextCursor: null });
  const match = ownerMatch(input.actor.ownerId, expression);

  // The best file of each matching artifact: SQLite takes the bare columns from the row of min().
  const best = db
    .select({
      artifactId: sql<string>`${sc.artifactId}`.as("hit_artifact_id"),
      chunkId: sql<number>`${sc.id}`.as("hit_chunk_id"),
      path: sql<string>`${sc.path}`.as("hit_path"),
      rank: sql<number>`min(search_text.rank)`.as("hit_rank"),
    })
    .from(sc)
    .innerJoin(sql`search_text`, sql`search_text.rowid = ${sc.id}`)
    .where(sql`search_text match ${match}`)
    .groupBy(sc.artifactId)
    .as("hits");
  const retention = versionRetention(owner.limits);
  const rows = await db
    .select({
      ...getTableColumns(a),
      ...activityColumns(retention, input.now),
      hitChunkId: best.chunkId,
      hitPath: best.path,
      partial: sa.partial,
    })
    .from(a)
    .innerJoin(best, eq(best.artifactId, a.id))
    .innerJoin(sa, eq(sa.artifactId, a.id))
    .where(
      and(
        eq(a.ownerId, input.actor.ownerId),
        eq(a.state, "active"),
        reachConditions(input.actor),
        after
          ? or(
              lt(a.updatedAt, after.updatedAt),
              and(eq(a.updatedAt, after.updatedAt), lt(a.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(a.updatedAt), desc(a.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const snippets = await snippetsFor(
    db,
    match,
    page.map((row) => Number(row.hitChunkId)),
  );
  const items = page.map(({ hitChunkId, hitPath, partial, ...row }) => ({
    artifact: withActivity(row),
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
