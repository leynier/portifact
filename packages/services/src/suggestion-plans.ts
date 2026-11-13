// Patch plans of suggestions and drafts on the server (decision 0027, "Automatic application: the
// patch plan"). A plan is built only from the stored files of the version a suggestion or draft
// is on: the published file at its path, decoded as UTF-8, and for a document its stored
// rendering and block map with the title they were rendered with, which is the artifact's name
// (a commit renders with it). If the name changed since, the installed renderer no longer
// reproduces the stored page and the plan lists everything (`renderer_changed`), so nothing is
// ever published with a rendering the person did not see. The live frame takes no part.
//
// Planning is rate limited per person and per artifact (`SUGGESTION_LIMITS`) and cached by digest
// for 10 minutes per person (`suggestion_plans`); the cache only saves a rebuild for previews,
// since accepting always rebuilds the plan and compares digests. Planning a suggestion on its
// current version also persists its proofs (`edit_proofs`), which is what lets a later publish
// carry it (`suggestion-versions.ts`).
import {
  DraftEdit,
  type Edit,
  type EditOperation,
  type FileKind,
  PLAN_LIMITS,
  PLANNING_RATE_LIMITS,
  type Plan,
  planningRateKeys,
  SUGGESTION_LIMITS,
} from "@portifact/contracts";
import {
  bothSides,
  type Db,
  hitRateLimits,
  type RateLimitHit,
  type RegionalDb,
  schema,
} from "@portifact/db";
import { fail, ok, type Result } from "@portifact/domain";
import {
  type BuiltPlan,
  buildPlan,
  decodeHtml,
  operationsOn,
  PlanTooLargeError,
  plannableKind,
  planPageUrl,
  proofsOfPlan,
} from "@portifact/domain/suggestions";
import { DOCUMENT_RENDERER } from "@portifact/render";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import {
  type AnnotationActor,
  type AuthorizedAnnotations,
  annotationParts,
} from "./annotations.ts";
import { previewSubject } from "./suggestion-previews.ts";
import { storedEdit, storedProofs } from "./suggestions.ts";

type ArtifactRow = typeof schema.artifacts.$inferSelect;
type ThreadRow = typeof schema.annotationThreads.$inferSelect;
type DraftRow = typeof schema.editDrafts.$inferSelect;

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** A stored page as a plan reads it. */
export interface StoredPage {
  kind: FileKind;
  path: string;
  /** The decoded file; empty when it was not read (`oversized`) or could not be decoded. */
  source: string;
  decoded: boolean;
  /** Over the planning limit by its stored size: never read, every operation `too_large`. */
  oversized: boolean;
  /**
   * Whether the stored bytes start with a UTF-8 byte order mark, decided once here: the decoded
   * source drops it, the new file keeps it, and the plan's output is of the bytes with it.
   */
  bom: boolean;
  sha256: string;
  contentType: string;
  entrypoint: string;
  stored?: { html: string; blockMap: string | null; options: { title: string } };
  pageUrl: string;
}

/** The largest stored file a plan reads, by kind (the planners refuse anything larger). */
const fileLimit = (kind: FileKind) =>
  kind === "html" ? PLAN_LIMITS.htmlBytes : PLAN_LIMITS.documentBytes;

/**
 * An object's bytes, read from its stream and never past `cap` (the stored size is checked
 * first; this bounds a mismatch too): null when it is missing, `too_large` past the cap.
 */
export async function readCapped(
  bucket: R2Bucket,
  key: string,
  cap: number,
): Promise<Uint8Array | null | "too_large"> {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > cap) {
    await object.body.cancel();
    return "too_large";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = object.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** The rows of a version's page and, for a document, of its stored rendering and block map. */
export interface StoredFiles {
  kind: FileKind;
  file: {
    path: string;
    sha256: string;
    size: number;
    contentType: string;
    r2Key: string;
    entrypoint: string;
  };
  rendered: { size: number; r2Key: string } | undefined;
  blockMap: { size: number; r2Key: string } | undefined;
  pageUrl: string;
}

/** The rows `storedPage` reads, before any byte: what is there and how large it is stored. */
export async function storedFiles(
  db: Db,
  input: { artifact: ArtifactRow; versionId: string; path: string; contentDomain: string },
): Promise<Result<StoredFiles>> {
  const vf = schema.versionFiles;
  const o = schema.objects;
  const rows = await db
    .select({
      kind: vf.kind,
      path: vf.path,
      sha256: vf.sha256,
      size: vf.size,
      contentType: vf.contentType,
      r2Key: o.r2Key,
      entrypoint: schema.versions.entrypoint,
    })
    .from(vf)
    .innerJoin(schema.versions, eq(schema.versions.id, vf.versionId))
    .innerJoin(o, and(eq(o.ownerId, vf.ownerId), eq(o.sha256, vf.sha256)))
    .where(
      and(
        eq(vf.versionId, input.versionId),
        eq(vf.path, input.path),
        inArray(vf.kind, ["published", "rendered", "block_map"]),
      ),
    );
  const file = rows.find((row) => row.kind === "published");
  if (!file) return fail("not_found", "The suggested page is not in this version.");
  const kind = plannableKind(input.artifact.type, file, file.entrypoint);
  if (kind === null) return fail("invalid_input", "Suggestions are made on pages and documents.");
  return ok({
    kind,
    file,
    rendered: rows.find((row) => row.kind === "rendered"),
    blockMap: rows.find((row) => row.kind === "block_map"),
    pageUrl: planPageUrl(kind, input.artifact.id, input.contentDomain, file.path),
  });
}

/** The page's own read limit (a mark included): a file stored larger is never read. */
const pageCap = (files: StoredFiles) => fileLimit(files.kind) + UTF8_BOM.length;
const baselineRead = (row: { size: number } | undefined) =>
  row && row.size <= SUGGESTION_LIMITS.renderingReadBytes ? row.size : 0;

/**
 * At most the bytes `readStoredPage` reads, from the stored sizes, before any byte is read:
 * every read is capped at its object's stored size, so the bytes read never exceed it.
 */
export function storedReadCost(files: StoredFiles, baseline: boolean): number {
  const source = files.file.size > pageCap(files) ? 0 : files.file.size;
  if (!baseline || files.kind === "html" || source === 0) return source;
  return source + baselineRead(files.rendered) + baselineRead(files.blockMap);
}

/**
 * Reads the page `files` describes, and with `baseline` a document's stored rendering and block
 * map, each checked by its stored size before any byte is read and read no further than it.
 * `read` is the bytes actually read.
 */
export async function readStoredPage(
  bucket: R2Bucket,
  files: StoredFiles,
  input: { artifact: ArtifactRow },
  baseline = true,
): Promise<Result<StoredPage & { read: number }>> {
  const { kind, file } = files;
  const base = {
    kind,
    path: file.path,
    sha256: file.sha256,
    contentType: file.contentType,
    entrypoint: file.entrypoint,
    pageUrl: files.pageUrl,
  };
  // Over the limit by its stored size (a mark included): listed without reading a byte.
  const bytes =
    file.size > pageCap(files) ? "too_large" : await readCapped(bucket, file.r2Key, file.size);
  if (bytes === null) return fail("not_found", "The suggested page is missing from storage.");
  if (bytes === "too_large") {
    return ok({ ...base, source: "", decoded: false, oversized: true, bom: false, read: 0 });
  }
  let read = bytes.byteLength;
  const decoded = decodeHtml(bytes);
  const page: StoredPage = {
    ...base,
    source: decoded ?? "",
    decoded: decoded !== null,
    oversized: false,
    bom: UTF8_BOM.every((byte, index) => bytes[index] === byte),
  };
  if (!baseline || kind === "html" || !page.decoded) return ok({ ...page, read });
  const fetch = async (row: { size: number; r2Key: string } | undefined) => {
    if (!row || row.size > SUGGESTION_LIMITS.renderingReadBytes) return null;
    const got = await readCapped(bucket, row.r2Key, row.size);
    if (got instanceof Uint8Array) read += got.byteLength;
    return got;
  };
  const html = await fetch(files.rendered);
  // A rendering that is missing or over its bound is no baseline: everything is listed.
  if (html === null || html === "too_large") return ok({ ...page, read });
  const map = await fetch(files.blockMap);
  const text = new TextDecoder();
  return ok({
    ...page,
    read,
    stored: {
      html: text.decode(html),
      blockMap: map === null || map === "too_large" ? null : text.decode(map),
      options: { title: input.artifact.name },
    },
  });
}

/**
 * Reads the published file at `path` of a version, and a document's stored rendering, each
 * checked by its stored size before any byte is read and read no further than it.
 */
export async function storedPage(
  db: Db,
  bucket: R2Bucket,
  input: { artifact: ArtifactRow; versionId: string; path: string; contentDomain: string },
): Promise<Result<StoredPage>> {
  const files = await storedFiles(db, input);
  if (!files.ok) return files;
  const page = await readStoredPage(bucket, files.value, input);
  if (!page.ok) return page;
  const { read: _read, ...rest } = page.value;
  return ok(rest);
}

/** The bytes of a plan's new file: the stored file's byte order mark, then the new source. */
export function newFileBytes(page: Pick<StoredPage, "bom">, source: string): Uint8Array {
  return new TextEncoder().encode(page.bom ? `\uFEFF${source}` : source);
}

export interface SubjectPlan {
  plan: BuiltPlan;
  page: StoredPage;
  /** The operations as given to the plan (a carried suggestion's at their carried positions). */
  operations: EditOperation[];
}

/** Whether an account still exists, for the envelope's people flags (never a name). */
async function accountExists(db: RegionalDb, userId: string): Promise<boolean> {
  const [row] = await db.global
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row !== undefined;
}

/** Builds a plan from the stored files; a plan over its size limits is `invalid_input`. */
async function plan(
  db: RegionalDb,
  bucket: R2Bucket,
  input: {
    artifact: ArtifactRow;
    versionId: string;
    path: string;
    subject: string;
    revision: number;
    operations: EditOperation[];
    submitter: string;
    acceptor: boolean;
    contentDomain: string;
  },
): Promise<Result<SubjectPlan>> {
  const page = await storedPage(db, bucket, input);
  if (!page.ok) return page;
  const p = page.value;
  try {
    const built = await buildPlan({
      binding: {
        artifactId: input.artifact.id,
        versionId: input.versionId,
        path: p.path,
        fileSha256: p.sha256,
        renderer: DOCUMENT_RENDERER.label,
        subject: input.subject,
        revision: input.revision,
      },
      people: { submitter: await accountExists(db, input.submitter), acceptor: input.acceptor },
      kind: p.kind,
      source: p.source,
      operations: input.operations,
      ...(p.stored ? { stored: p.stored } : {}),
      pageUrl: p.pageUrl,
      renderer: DOCUMENT_RENDERER,
      ...(p.oversized
        ? { refuse: "too_large" as const }
        : p.decoded
          ? {}
          : { refuse: "not_eligible" as const }),
      bom: p.bom,
    });
    return ok({ plan: built, page: p, operations: input.operations });
  } catch (error) {
    if (error instanceof PlanTooLargeError) {
      return fail("invalid_input", "This change is too large to plan. Split it into smaller ones.");
    }
    throw error;
  }
}

/** The plan of a suggestion on the version it is on, as `acceptor` (the owner side) or not. */
export async function suggestionPlanOf(
  db: RegionalDb,
  bucket: R2Bucket,
  input: { artifact: ArtifactRow; thread: ThreadRow; acceptor: boolean; contentDomain: string },
): Promise<Result<SubjectPlan>> {
  const edit = storedEdit(input.thread);
  if (!edit) return fail("invalid_input", "This suggestion holds no edit.");
  return plan(db, bucket, {
    artifact: input.artifact,
    versionId: input.thread.versionId,
    path: input.thread.path,
    subject: input.thread.id,
    revision: input.thread.suggestionRevision,
    operations: operationsOn(edit, storedProofs(input.thread), input.thread.versionId),
    submitter: input.thread.authorId,
    acceptor: input.acceptor,
    contentDomain: input.contentDomain,
  });
}

/** The subject a draft's plan binds. */
export const draftSubject = (userId: string) => `draft:${userId}`;

/** The plan of a person's draft on its base version. */
export async function draftPlanOf(
  db: RegionalDb,
  bucket: R2Bucket,
  input: { artifact: ArtifactRow; draft: DraftRow; contentDomain: string },
): Promise<Result<SubjectPlan>> {
  const parsed = DraftEdit.safeParse(JSON.parse(input.draft.edit));
  if (!parsed.success) return fail("invalid_input", "The draft cannot be read.");
  const edit: Edit = parsed.data;
  const path = (edit.operations[0] as EditOperation).target.path;
  return plan(db, bucket, {
    artifact: input.artifact,
    versionId: input.draft.baseVersionId,
    path,
    subject: draftSubject(input.draft.userId),
    revision: input.draft.revision,
    operations: edit.operations,
    submitter: input.draft.userId,
    acceptor: true,
    contentDomain: input.contentDomain,
  });
}

/** The subject an unsaved edit's plan binds: nothing stored, so nothing to name but the person. */
export const unsavedSubject = (userId: string) => `unsaved:${userId}`;

/**
 * The plan of an edit nobody saved (decision 0027, "Previews"), on `versionId`, for a preview
 * only: it is never cached, never confirmed and never written anywhere. A suggestion's edit is
 * planned as its reviewer would see it, a draft's as the owner side would (`acceptor`).
 */
export async function unsavedPlanOf(
  db: RegionalDb,
  bucket: R2Bucket,
  input: {
    artifact: ArtifactRow;
    userId: string;
    versionId: string;
    edit: Edit;
    acceptor: boolean;
    contentDomain: string;
  },
): Promise<Result<SubjectPlan>> {
  const path = (input.edit.operations[0] as EditOperation).target.path;
  return plan(db, bucket, {
    artifact: input.artifact,
    versionId: input.versionId,
    path,
    subject: unsavedSubject(input.userId),
    revision: 0,
    operations: input.edit.operations,
    submitter: input.userId,
    acceptor: input.acceptor,
    contentDomain: input.contentDomain,
  });
}

/**
 * Counts one plan for the person and the artifact; `rate_limited` past either limit. Dry runs,
 * acceptances and draft publishes all count here, after authorization and before any file is
 * read, so a refused or wrong confirmation costs the same budget as a plan.
 */
export async function admitPlanning(
  db: RegionalDb,
  userId: string,
  artifactId: string,
  now: number,
): Promise<Result<true>> {
  const keys = planningRateKeys(userId, artifactId);
  const [person] = (await hitRateLimits(
    db.global.$client,
    [keys.user],
    PLANNING_RATE_LIMITS.perUser.windowMs,
    now,
  )) as [RateLimitHit];
  const [artifact] = (await hitRateLimits(
    db.global.$client,
    [keys.artifact],
    PLANNING_RATE_LIMITS.perArtifact.windowMs,
    now,
  )) as [RateLimitHit];
  if (
    person.count > PLANNING_RATE_LIMITS.perUser.requests ||
    artifact.count > PLANNING_RATE_LIMITS.perArtifact.requests
  ) {
    return fail("rate_limited", "Too many plans in a short time. Try again in a few minutes.");
  }
  return ok(true);
}

/** What a client receives of a plan: its contents and digest, never its bytes or proofs. */
export function suggestionPlanView(built: BuiltPlan): Plan {
  const { format, binding, kind, applied, listed, output, lines, digest } = built;
  return { format, binding, kind, applied, listed, output, lines, digest };
}

/**
 * Keeps a plan by its digest for the person, for 10 minutes, only while `guard` holds: the
 * authorization the plan was built under, checked inside the batch. Returns the row it wrote.
 */
function cachePlan(
  db: Db,
  input: { userId: string; artifactId: string; threadId: string | null; plan: Plan; now: number },
  guard: SQL,
) {
  const text = JSON.stringify(input.plan);
  const expires = input.now + PLAN_LIMITS.cacheMinutes * 60_000;
  // Columns in schema order: user, digest, artifact, thread, plan, created, expires.
  return db
    .insert(schema.suggestionPlans)
    .select(
      sql`select ${input.userId}, ${input.plan.digest}, ${input.artifactId}, ${input.threadId}, ${text}, ${input.now}, ${expires} where ${guard}`,
    )
    .onConflictDoUpdate({
      target: [schema.suggestionPlans.userId, schema.suggestionPlans.digest],
      set: { plan: text, expiresAt: expires },
    })
    .returning({ digest: schema.suggestionPlans.digest });
}

const th = schema.annotationThreads;

/** What a suggestion's plan writes need still to hold: everything it was authorized on. */
function suggestionPlanGuard(loaded: AuthorizedAnnotations, thread: ThreadRow, now: number): SQL {
  const t = schema.artifacts;
  return sql`${annotationParts.artifactGuard(loaded, "read", now)} and exists (select 1 from ${t} where ${t.id} = ${loaded.artifact.id} and ${t.currentVersionId} = ${thread.versionId}) and exists (select 1 from ${th} where ${th.id} = ${thread.id} and ${th.suggestionState} = 'pending' and ${th.versionId} = ${thread.versionId} and ${th.suggestionRevision} = ${thread.suggestionRevision}) and ${annotationParts.scopeGuard(loaded, thread.id)}`;
}

/**
 * A pending suggestion the caller may see a plan of (`previewSubject`, the one rule for plans
 * and previews), on the artifact's current version.
 */
async function plannableSuggestion(
  db: RegionalDb,
  input: AnnotationActor & { threadId: string },
): Promise<Result<{ loaded: AuthorizedAnnotations; thread: ThreadRow }>> {
  const subject = await previewSubject(db, input, { threadId: input.threadId, revision: null });
  if (!subject.ok) return subject;
  const { standing, thread } = subject.value;
  if (thread.versionId !== standing.artifact.currentVersionId) {
    return fail("version_conflict", "This suggestion was made on an earlier version.");
  }
  // `readableThread` authorized the caller to read: a role is set.
  return ok({ loaded: standing as AuthorizedAnnotations, thread });
}

/**
 * Where a plan's batch runs and the live standing it holds (`liveStanding`): named in the batch
 * when the region's database is the global one, read again right before it otherwise; null when
 * that read refuses, so the batch does not run (fail closed). With a separate database a removal
 * between that read and the batch is not seen, the one window (decision 0027).
 */
export async function planBatchOn(
  db: RegionalDb,
  loaded: AuthorizedAnnotations,
): Promise<{ w: Db; standing: SQL } | null> {
  const facts = annotationParts.liveStanding(loaded);
  if (facts === null) return { w: db, standing: sql`1` };
  const both = bothSides(db);
  if (both) return { w: both, standing: facts };
  return (await annotationParts.standingHolds(db, loaded)) ? { w: db, standing: sql`1` } : null;
}

/** What a request whose guarded write lost answers: a fresh refusal, never the plan. */
async function lostPlan<T>(again: Promise<Result<T>>): Promise<Result<never>> {
  const fresh = await again;
  return fresh.ok
    ? fail("version_conflict", "The suggestion changed meanwhile. Plan it again.")
    : fresh;
}

/**
 * Builds the plan of a pending suggestion on the artifact's current version, for whoever sees
 * its thread: the owner side's confirmation (as the acceptor) or the reviewer's own. Persists the
 * suggestion's proofs on that version, so a later publish can carry it. The cache row and the
 * proofs are written in one batch held to the authorization the plan was built under (owner,
 * state, mode, version, the suggestion's state and revision, the reader's live comment scope);
 * when that no longer holds, the plan is not returned.
 */
export async function planSuggestion(
  db: RegionalDb,
  bucket: R2Bucket,
  input: AnnotationActor & { threadId: string; contentDomain: string },
): Promise<Result<Plan>> {
  const found = await plannableSuggestion(db, input);
  if (!found.ok) return found;
  const { loaded, thread } = found.value;
  const { artifact } = loaded;
  const admitted = await admitPlanning(db, input.userId, artifact.id, input.now);
  if (!admitted.ok) return admitted;
  const built = await suggestionPlanOf(db, bucket, {
    artifact,
    thread,
    acceptor: loaded.role === "owner",
    contentDomain: input.contentDomain,
  });
  if (!built.ok) return built;
  const { plan: result, operations } = built.value;
  const view = suggestionPlanView(result);
  const proofs = JSON.stringify(proofsOfPlan(result, operations, thread.versionId));
  const on = await planBatchOn(db, loaded);
  if (!on) return lostPlan(plannableSuggestion(db, input));
  const { w } = on;
  const guard = sql`${suggestionPlanGuard(loaded, thread, input.now)} and ${on.standing}`;
  const [cached] = await w.batch([
    cachePlan(
      w,
      {
        userId: input.userId,
        artifactId: artifact.id,
        threadId: thread.id,
        plan: view,
        now: input.now,
      },
      guard,
    ),
    w
      .update(th)
      .set({ editProofs: proofs })
      .where(and(eq(th.id, thread.id), sql`${th.editProofs} is not ${proofs}`, guard)),
  ]);
  if (cached.length === 0) return lostPlan(plannableSuggestion(db, input));
  return ok(view);
}

/**
 * The owner side's draft on an artifact: only its author's, and only while they act for the
 * owner. A draft answers as missing to anyone else.
 */
export async function ownDraft(
  db: RegionalDb,
  input: AnnotationActor,
  action: "read" | "moderate",
): Promise<Result<{ loaded: AuthorizedAnnotations; draft: DraftRow }>> {
  const loaded = await annotationParts.authorize(db, input, action);
  if (!loaded.ok) return loaded;
  const missing = fail<never>("not_found", "Draft not found.");
  if (loaded.value.role !== "owner") return missing;
  const [draft] = await db
    .select()
    .from(schema.editDrafts)
    .where(
      and(
        eq(schema.editDrafts.artifactId, input.artifactId),
        eq(schema.editDrafts.userId, input.userId),
      ),
    )
    .limit(1);
  return draft ? ok({ loaded: loaded.value, draft }) : missing;
}

/** Builds the plan of one's own draft on its base version, which must be current. */
export async function planDraft(
  db: RegionalDb,
  bucket: R2Bucket,
  input: AnnotationActor & { contentDomain: string },
): Promise<Result<Plan>> {
  const found = await draftAtCurrentVersion(db, input);
  if (!found.ok) return found;
  const { loaded, draft } = found.value;
  const admitted = await admitPlanning(db, input.userId, loaded.artifact.id, input.now);
  if (!admitted.ok) return admitted;
  const built = await draftPlanOf(db, bucket, {
    artifact: loaded.artifact,
    draft,
    contentDomain: input.contentDomain,
  });
  if (!built.ok) return built;
  const view = suggestionPlanView(built.value.plan);
  const on = await planBatchOn(db, loaded);
  if (!on) return lostPlan(draftAtCurrentVersion(db, input));
  const { w } = on;
  const [cached] = await w.batch([
    cachePlan(
      w,
      {
        userId: input.userId,
        artifactId: loaded.artifact.id,
        threadId: null,
        plan: view,
        now: input.now,
      },
      sql`${draftPlanGuard(loaded, draft, input.now)} and ${on.standing}`,
    ),
  ]);
  if (cached.length === 0) return lostPlan(draftAtCurrentVersion(db, input));
  return ok(view);
}

/** A draft's plan write needs: the artifact as authorized at the base, the draft unchanged. */
function draftPlanGuard(loaded: AuthorizedAnnotations, draft: DraftRow, now: number): SQL {
  const t = schema.artifacts;
  const d = schema.editDrafts;
  return sql`${annotationParts.artifactGuard(loaded, "read", now)} and exists (select 1 from ${t} where ${t.id} = ${loaded.artifact.id} and ${t.currentVersionId} = ${draft.baseVersionId}) and exists (select 1 from ${d} where ${d.artifactId} = ${draft.artifactId} and ${d.userId} = ${draft.userId} and ${d.revision} = ${draft.revision})`;
}

async function draftAtCurrentVersion(
  db: RegionalDb,
  input: AnnotationActor,
): Promise<Result<{ loaded: AuthorizedAnnotations; draft: DraftRow }>> {
  const found = await ownDraft(db, input, "read");
  if (!found.ok) return found;
  if (found.value.draft.baseVersionId !== found.value.loaded.artifact.currentVersionId) {
    return fail("version_conflict", "A newer version was published since this draft began.");
  }
  return found;
}
