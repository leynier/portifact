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
  type Plan,
  PLAN_LIMITS,
  SUGGESTION_LIMITS,
} from "@portifact/contracts";
import { type Db, hitRateLimits, type RateLimitHit, type RegionalDb, schema } from "@portifact/db";
import { fail, ok, type Result } from "@portifact/domain";
import {
  type BuiltPlan,
  buildPlan,
  decodeHtml,
  operationsOn,
  PlanTooLargeError,
  plannableKind,
  proofsOfPlan,
} from "@portifact/domain/suggestions";
import { DOCUMENT_RENDERER } from "@portifact/render";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type AnnotationActor, type AuthorizedAnnotations, annotationParts } from "./annotations.ts";
import { storedEdit, storedProofs } from "./suggestions.ts";

type ArtifactRow = typeof schema.artifacts.$inferSelect;
type ThreadRow = typeof schema.annotationThreads.$inferSelect;
type DraftRow = typeof schema.editDrafts.$inferSelect;

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** A stored page as a plan reads it. */
export interface StoredPage {
  kind: FileKind;
  path: string;
  /** The decoded file; an undecodable one is planned with every operation listed. */
  source: string;
  decoded: boolean;
  /** Whether the stored bytes start with a UTF-8 byte order mark, which a new file keeps. */
  bom: boolean;
  sha256: string;
  contentType: string;
  entrypoint: string;
  stored?: { html: string; blockMap: string | null; options: { title: string } };
  pageUrl: string;
}

/** The URL a page is served at on the artifact's origin, for link destinations. */
export function pageUrlOf(artifactId: string, kind: FileKind, path: string, domain: string) {
  return kind === "html"
    ? `https://${artifactId}.${domain}/${path.split("/").map(encodeURIComponent).join("/")}`
    : `https://${artifactId}.${domain}/`;
}

async function objectText(bucket: R2Bucket, key: string): Promise<Uint8Array | null> {
  const object = await bucket.get(key);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

/** Reads the published file at `path` of a version, and a document's stored rendering. */
export async function storedPage(
  db: Db,
  bucket: R2Bucket,
  input: { artifact: ArtifactRow; versionId: string; path: string; contentDomain: string },
): Promise<Result<StoredPage>> {
  const vf = schema.versionFiles;
  const o = schema.objects;
  const rows = await db
    .select({
      kind: vf.kind,
      path: vf.path,
      sha256: vf.sha256,
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
  const bytes = await objectText(bucket, file.r2Key);
  if (!bytes) return fail("not_found", "The suggested page is missing from storage.");
  const decoded = decodeHtml(bytes);
  const page: StoredPage = {
    kind,
    path: file.path,
    source: decoded ?? new TextDecoder().decode(bytes),
    decoded: decoded !== null,
    bom: UTF8_BOM.every((byte, index) => bytes[index] === byte),
    sha256: file.sha256,
    contentType: file.contentType,
    entrypoint: file.entrypoint,
    pageUrl: pageUrlOf(input.artifact.id, kind, file.path, input.contentDomain),
  };
  if (kind === "html") return ok(page);
  const rendered = rows.find((row) => row.kind === "rendered");
  const blockMap = rows.find((row) => row.kind === "block_map");
  const html = rendered ? await objectText(bucket, rendered.r2Key) : null;
  const map = blockMap ? await objectText(bucket, blockMap.r2Key) : null;
  if (html === null) return ok(page);
  const text = new TextDecoder();
  return ok({
    ...page,
    stored: {
      html: text.decode(html),
      blockMap: map === null ? null : text.decode(map),
      options: { title: input.artifact.name },
    },
  });
}

/** The bytes of a plan's new file, keeping the stored file's byte order mark. */
export function newFileBytes(page: Pick<StoredPage, "bom">, source: string): Uint8Array {
  const text = page.bom && !source.startsWith("﻿") ? `﻿${source}` : source;
  return new TextEncoder().encode(text);
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
      ...(p.decoded ? {} : { refuse: "not_eligible" as const }),
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

/** Counts one plan for the person and the artifact; `rate_limited` past either limit. */
async function admitPlanning(
  db: RegionalDb,
  userId: string,
  artifactId: string,
  now: number,
): Promise<Result<true>> {
  const limits = SUGGESTION_LIMITS;
  const [person] = (await hitRateLimits(
    db.global.$client,
    [`suggestion_plan:user:${userId}`],
    limits.plansPersonWindowMs,
    now,
  )) as [RateLimitHit];
  const [artifact] = (await hitRateLimits(
    db.global.$client,
    [`suggestion_plan:artifact:${artifactId}`],
    limits.plansArtifactWindowMs,
    now,
  )) as [RateLimitHit];
  if (person.count > limits.plansPerPerson || artifact.count > limits.plansPerArtifact) {
    return fail("rate_limited", "Too many plans in a short time. Try again in a few minutes.");
  }
  return ok(true);
}

/** What a client receives of a plan: its contents and digest, never its bytes or proofs. */
export function planView(built: BuiltPlan): Plan {
  const { format, binding, kind, applied, listed, output, lines, digest } = built;
  return { format, binding, kind, applied, listed, output, lines, digest };
}

/** Keeps a plan by its digest for the person, for 10 minutes. */
function cachePlan(
  db: RegionalDb,
  input: { userId: string; artifactId: string; threadId: string | null; plan: Plan; now: number },
) {
  const text = JSON.stringify(input.plan);
  return db
    .insert(schema.suggestionPlans)
    .values({
      userId: input.userId,
      digest: input.plan.digest,
      artifactId: input.artifactId,
      threadId: input.threadId,
      plan: text,
      createdAt: input.now,
      expiresAt: input.now + PLAN_LIMITS.cacheMinutes * 60_000,
    })
    .onConflictDoUpdate({
      target: [schema.suggestionPlans.userId, schema.suggestionPlans.digest],
      set: { plan: text, expiresAt: input.now + PLAN_LIMITS.cacheMinutes * 60_000 },
    });
}

/**
 * Builds the plan of a pending suggestion on the artifact's current version, for whoever sees
 * its thread: the owner side's confirmation (as the acceptor) or the reviewer's own. Persists the
 * suggestion's proofs on that version, so a later publish can carry it.
 */
export async function planSuggestion(
  db: RegionalDb,
  bucket: R2Bucket,
  input: AnnotationActor & { threadId: string; contentDomain: string },
): Promise<Result<Plan>> {
  const loaded = await annotationParts.authorize(db, input, "read");
  if (!loaded.ok) return loaded;
  const thread = await annotationParts.findThread(db, loaded.value, input.threadId);
  if (!thread || thread.kind !== "suggestion") return fail("not_found", "Suggestion not found.");
  if (thread.suggestionState !== "pending") {
    return fail("invalid_input", "Only a pending suggestion is planned.");
  }
  const { artifact } = loaded.value;
  if (thread.versionId !== artifact.currentVersionId) {
    return fail("version_conflict", "This suggestion was made on an earlier version.");
  }
  const admitted = await admitPlanning(db, input.userId, artifact.id, input.now);
  if (!admitted.ok) return admitted;
  const built = await suggestionPlanOf(db, bucket, {
    artifact,
    thread,
    acceptor: loaded.value.role === "owner",
    contentDomain: input.contentDomain,
  });
  if (!built.ok) return built;
  const { plan: result, operations } = built.value;
  const view = planView(result);
  const proofs = JSON.stringify(proofsOfPlan(result, operations, thread.versionId));
  const th = schema.annotationThreads;
  await db.batch([
    cachePlan(db, { userId: input.userId, artifactId: artifact.id, threadId: thread.id, plan: view, now: input.now }),
    // Only for the suggestion as planned: still pending, on that version, at that revision.
    db
      .update(th)
      .set({ editProofs: proofs })
      .where(
        and(
          eq(th.id, thread.id),
          eq(th.suggestionState, "pending"),
          eq(th.versionId, thread.versionId),
          eq(th.suggestionRevision, thread.suggestionRevision),
          sql`${th.editProofs} is not ${proofs}`,
        ),
      ),
  ]);
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
  const found = await ownDraft(db, input, "read");
  if (!found.ok) return found;
  const { loaded, draft } = found.value;
  if (draft.baseVersionId !== loaded.artifact.currentVersionId) {
    return fail("version_conflict", "A newer version was published since this draft began.");
  }
  const admitted = await admitPlanning(db, input.userId, loaded.artifact.id, input.now);
  if (!admitted.ok) return admitted;
  const built = await draftPlanOf(db, bucket, {
    artifact: loaded.artifact,
    draft,
    contentDomain: input.contentDomain,
  });
  if (!built.ok) return built;
  const view = planView(built.value.plan);
  await cachePlan(db, {
    userId: input.userId,
    artifactId: loaded.artifact.id,
    threadId: null,
    plan: view,
    now: input.now,
  });
  return ok(view);
}
