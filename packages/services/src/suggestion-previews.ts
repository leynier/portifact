// Built previews of edit suggestions on the preview origin (decision 0027, "Previews"). The app
// issues a one-use code for a stored plan to a person who may read the suggestion's thread; the
// content Worker redeems it on `preview.<content domain>`, re-checking the same rule, and answers
// with the document built here.
//
// What is computed when. At issue: the authorization, the planning rate limit, one read of the
// stored file (and, for a document, of its stored rendering and block map), the plan rebuilt from
// them and the suggestion's edit (its digest must be the stored plan's, so the preview shows
// exactly what the person was shown), the preview built by the domain (`previewOfPlan`), one code
// row and one R2 write. The cost is the plan's, bounded inside the planners by `PLAN_LIMITS`, and
// counted with dry runs in `PLANNING_RATE_LIMITS`. At redemption: one guarded update per region,
// one session read, the thread's read authorization again, one R2 read and one delete: no plan,
// no parse, no render.
//
// Only the code's SHA-256 is stored. A code is never logged, audited or written anywhere else.
import {
  Edit,
  type EnvelopePeople,
  type FileKind,
  isServiceTokenId,
  PLAN_LIMITS,
  PLANNING_RATE_LIMITS,
  Plan,
  PREVIEW_CODES,
  PreviewCode,
  planningRateKeys,
  previewHost,
} from "@portifact/contracts";
import { hitRateLimit, type RegionalDb, type Regions, schema } from "@portifact/db";
import { fail, ok, type Result } from "@portifact/domain";
import {
  buildPlan,
  PlanTooLargeError,
  planPageUrl,
  previewOfPlan,
  type StoredRendering,
} from "@portifact/domain/suggestions";
import { DOCUMENT_RENDERER } from "@portifact/render";
import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import { type CommentStanding, readableThread } from "./annotations.ts";

type ThreadRow = typeof schema.annotationThreads.$inferSelect;

export interface PreviewIssueInput {
  userId: string;
  /** The dashboard session that asks; the code is redeemed only while it lives. */
  sessionId: string;
  artifactId: string;
  /** The plan the person holds, by its digest (`suggestion_plans`, cached per person). */
  digest: string;
  now: number;
  contentDomain: string;
}

export type IssuedPreview =
  | { state: "ready"; url: string; expiresAt: number }
  | { state: "unavailable"; reasons: string[] };

const missingPlan = () => fail<never>("not_found", "Preview not found.");
const planChanged = () =>
  fail<never>("version_conflict", "The suggestion or the artifact changed. Review it again.");

/**
 * The seam with the suggestion services: whether the caller may see a plan's subject now, by the
 * rules of reading the suggestion's thread (`readableThread`: role, state, comment mode, comment
 * scope, the version a visitor sees, legal holds), a person only, the suggestion still pending at
 * the revision the plan was built for, on an active artifact. Drafts (`draft:<user>`) and unsaved
 * edits are previewed by the suggestion services; they answer like a missing plan here.
 */
export async function previewSubject(
  db: RegionalDb,
  input: { userId: string; artifactId: string; now: number },
  subject: { threadId: string; revision: number | null },
): Promise<Result<{ standing: CommentStanding; thread: ThreadRow }>> {
  if (isServiceTokenId(input.userId)) return missingPlan();
  const readable = await readableThread(db, { ...input, threadId: subject.threadId });
  if (!readable.ok) return readable.code === "not_found" ? missingPlan() : readable;
  const { standing, thread } = readable.value;
  // Content is shown only while the artifact is: never archived or suspended (held or not).
  if (standing.state !== "active") return missingPlan();
  if (thread.kind !== "suggestion" || thread.edit === null) return missingPlan();
  if (thread.suggestionState !== "pending") return planChanged();
  if (subject.revision !== null && thread.suggestionRevision !== subject.revision) {
    return planChanged();
  }
  return ok({ standing, thread });
}

/** The file kind a plan of this artifact type must have. */
const KIND_OF_TYPE: Readonly<Record<string, FileKind>> = {
  site: "html",
  markdown: "markdown",
  text: "text",
};

/** One stored entry of a version as text, or undefined when it is missing or over `maxBytes`. */
async function storedText(
  db: RegionalDb,
  bucket: R2Bucket,
  where: { versionId: string; kind: "published" | "rendered" | "block_map"; path: string },
  maxBytes: number,
): Promise<string | undefined> {
  const vf = schema.versionFiles;
  const o = schema.objects;
  const [row] = await db
    .select({ r2Key: o.r2Key, size: vf.size })
    .from(vf)
    .innerJoin(o, and(eq(o.ownerId, vf.ownerId), eq(o.sha256, vf.sha256)))
    .where(and(eq(vf.versionId, where.versionId), eq(vf.kind, where.kind), eq(vf.path, where.path)))
    .limit(1);
  if (!row || row.size > maxBytes) return undefined;
  const object = await bucket.get(row.r2Key);
  if (!object) return undefined;
  try {
    // The subset decodes strictly; a file that is not UTF-8 never had an applicable plan.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      await object.arrayBuffer(),
    );
  } catch {
    return undefined;
  }
}

/** The SHA-256 of a version entry, to check the plan's binding without reading the bytes. */
async function storedSha256(db: RegionalDb, versionId: string, path: string) {
  const vf = schema.versionFiles;
  const [row] = await db
    .select({ sha256: vf.sha256 })
    .from(vf)
    .where(and(eq(vf.versionId, versionId), eq(vf.kind, "published"), eq(vf.path, path)))
    .limit(1);
  return row?.sha256;
}

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Issues a one-use preview code for the caller's stored plan. Authorization comes first and a
 * plan, thread or artifact the caller may not see answers like a missing one; then the planning
 * rate limit; then the plan is rebuilt from the stored files and must have the stored digest. A
 * plan that applies nothing, or whose page the builder refuses, answers `unavailable` with its
 * reasons and issues nothing: the viewer never shows the unchanged page as if it were changed.
 */
export async function issuePreviewCode(
  db: RegionalDb,
  bucket: R2Bucket,
  input: PreviewIssueInput,
): Promise<Result<IssuedPreview>> {
  const { userId, artifactId, now } = input;
  const p = schema.suggestionPlans;
  const [row] = await db
    .select({ plan: p.plan, threadId: p.threadId })
    .from(p)
    .where(
      and(
        eq(p.userId, userId),
        eq(p.digest, input.digest),
        eq(p.artifactId, artifactId),
        gt(p.expiresAt, now),
      ),
    )
    .limit(1);
  if (!row || row.threadId === null) return missingPlan();
  const parsed = Plan.safeParse(safeJson(row.plan));
  if (!parsed.success) return missingPlan();
  const plan = parsed.data;
  const { binding } = plan;
  if (
    plan.digest !== input.digest ||
    binding.artifactId !== artifactId ||
    binding.subject !== row.threadId
  ) {
    return missingPlan();
  }
  const subject = await previewSubject(
    db,
    { userId, artifactId, now },
    { threadId: row.threadId, revision: binding.revision },
  );
  if (!subject.ok) return subject;
  const { standing, thread } = subject.value;

  const keys = planningRateKeys(userId, artifactId);
  const perUser = await hitRateLimit(
    db.global.$client,
    keys.user,
    PLANNING_RATE_LIMITS.perUser.windowMs,
    now,
  );
  const perArtifact = await hitRateLimit(
    db.global.$client,
    keys.artifact,
    PLANNING_RATE_LIMITS.perArtifact.windowMs,
    now,
  );
  if (
    perUser.count > PLANNING_RATE_LIMITS.perUser.requests ||
    perArtifact.count > PLANNING_RATE_LIMITS.perArtifact.requests
  ) {
    return fail("rate_limited", "Too many previews. Wait a moment.");
  }

  const kind = KIND_OF_TYPE[standing.artifact.type];
  if (kind !== plan.kind || standing.artifact.currentVersionId !== binding.versionId) {
    return planChanged();
  }
  // Nothing applies: the plan says why, and nothing is read or built.
  if (plan.output === null) {
    return ok({ state: "unavailable", reasons: plan.listed.map((e) => e.reason ?? "unknown") });
  }
  if ((await storedSha256(db, binding.versionId, binding.path)) !== binding.fileSha256) {
    return planChanged();
  }
  const limit = kind === "html" ? PLAN_LIMITS.htmlBytes : PLAN_LIMITS.documentBytes;
  const where = { versionId: binding.versionId, path: binding.path };
  const source = await storedText(db, bucket, { ...where, kind: "published" }, limit);
  if (source === undefined) return planChanged();
  let stored: StoredRendering | undefined;
  if (kind !== "html") {
    // The stored page is at most the renderer's output of a bounded file; a generous bound.
    const pageLimit = 8 * PLAN_LIMITS.documentBytes;
    const html = await storedText(db, bucket, { ...where, kind: "rendered" }, pageLimit);
    const blockMap =
      kind === "markdown"
        ? await storedText(db, bucket, { ...where, kind: "block_map" }, pageLimit)
        : null;
    if (html === undefined || blockMap === undefined || plan.output.options === null) {
      return planChanged();
    }
    stored = { html, blockMap, options: plan.output.options };
  }
  const edit = Edit.safeParse(safeJson(thread.edit ?? ""));
  const people = plan.applied[0]?.people ?? plan.listed[0]?.people;
  if (!edit.success || !people) return planChanged();

  const rebuilt = await rebuild({
    binding,
    people,
    kind,
    source,
    operations: edit.data.operations,
    stored,
    pageUrl: planPageUrl(kind, artifactId, input.contentDomain, binding.path),
  });
  if (!rebuilt || rebuilt.digest !== plan.digest) return planChanged();
  const preview = previewOfPlan(rebuilt, DOCUMENT_RENDERER);
  if (preview.state === "unavailable") return ok(preview);

  const code = newCode();
  const codeSha256 = await sha256Hex(code);
  const r2Key = previewKey(now);
  const expiresAt = now + PREVIEW_CODES.ttlMs;
  try {
    await db.insert(schema.previewCodes).values({
      codeSha256,
      userId,
      sessionId: input.sessionId,
      artifactId,
      threadId: thread.id,
      r2Key,
      createdAt: now,
      expiresAt,
    });
  } catch (error) {
    if (causeIncludes(error, "preview_codes_limit")) {
      return fail("rate_limited", "Too many previews open. Wait a minute and try again.");
    }
    throw error;
  }
  // The row first: a document is never stored without a row the scan can find.
  await bucket.put(r2Key, preview.document, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  return ok({
    state: "ready",
    url: `https://${previewHost(input.contentDomain)}${PREVIEW_CODES.pathPrefix}${code}`,
    expiresAt,
  });
}

async function rebuild(input: {
  binding: Plan["binding"];
  people: EnvelopePeople;
  kind: FileKind;
  source: string;
  operations: Edit["operations"];
  stored: StoredRendering | undefined;
  pageUrl: string;
}) {
  const { route: _route, ...binding } = input.binding;
  try {
    return await buildPlan({
      binding,
      people: input.people,
      kind: input.kind,
      source: input.source,
      operations: input.operations,
      ...(input.stored ? { stored: input.stored } : {}),
      pageUrl: input.pageUrl,
      renderer: DOCUMENT_RENDERER,
    });
  } catch (error) {
    if (error instanceof PlanTooLargeError) return undefined;
    throw error;
  }
}

function causeIncludes(error: unknown, text: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes(text)) return true;
  }
  return false;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Redeems a preview code once and returns the built document, or undefined for anything else:
 * a malformed, unknown, used or expired code; a dashboard session that ended; a thread the person
 * may no longer read (access narrowed, a transfer, a suspension or hold, the suggestion withdrawn
 * or decided); a document no longer in the cache. Every refusal is the same to the caller. The
 * code is spent by its guarded update before anything else, so a second use never succeeds.
 */
export async function redeemPreviewCode(
  regions: Regions,
  code: string,
  now: number,
): Promise<string | undefined> {
  if (!PreviewCode.safeParse(code).success) return undefined;
  const codeSha256 = await sha256Hex(code);
  const c = schema.previewCodes;
  const all = regions.all();
  // Codes carry no region; at most one region holds the row (one round trip each, in parallel).
  const spent = await Promise.all(
    all.map(async (handles) => {
      const [row] = await handles.db
        .update(c)
        .set({ redeemedAt: now })
        .where(and(eq(c.codeSha256, codeSha256), isNull(c.redeemedAt), gt(c.expiresAt, now)))
        .returning({
          userId: c.userId,
          sessionId: c.sessionId,
          artifactId: c.artifactId,
          threadId: c.threadId,
          r2Key: c.r2Key,
        });
      return row ? { handles, row } : undefined;
    }),
  );
  const found = spent.find((each) => each !== undefined);
  if (!found?.handles.bucket) return undefined;
  const { handles, row } = found;
  const bucket = handles.bucket as R2Bucket;
  try {
    const s = schema.sessions;
    const [session] = await regions.global
      .select({ id: s.id })
      .from(s)
      .where(and(eq(s.id, row.sessionId), eq(s.userId, row.userId), gt(s.expiresAt, new Date(now))))
      .limit(1);
    if (!session || row.threadId === null) return undefined;
    const subject = await previewSubject(
      handles.db,
      { userId: row.userId, artifactId: row.artifactId, now },
      { threadId: row.threadId, revision: null },
    );
    if (!subject.ok) return undefined;
    const object = await bucket.get(row.r2Key);
    return object ? await object.text() : undefined;
  } finally {
    // A spent code's document is never needed again, whatever the answer.
    await bucket.delete(row.r2Key);
  }
}

/** Codes and documents pruned per region per run. */
const PRUNE_BATCH = 90;

/** Every cached document's key starts with its creation time, so the scan needs no row. */
const KEY_TIME_DIGITS = 15;

/** The internal cache key of a document built at `now`: `previews/<time>/<random>`. */
export function previewKey(now: number): string {
  return `previews/${String(now).padStart(KEY_TIME_DIGITS, "0")}/${crypto.randomUUID()}`;
}

/**
 * Deletes cached preview documents and preview codes once the cache's lifetime has passed,
 * redeemed or not. Documents are found by their key, which starts with their creation time, so a
 * document whose row went another way (an account deletion deletes the rows) is still deleted.
 */
export async function prunePreviewCodes(
  db: RegionalDb,
  bucket: R2Bucket,
  now: number,
): Promise<number> {
  const cutoff = now - PREVIEW_CODES.documentTtlMs;
  const listed = await bucket.list({ prefix: "previews/", limit: PRUNE_BATCH });
  // Keys sort by their time: the old ones come first, and the listing stops being due at once.
  const old = listed.objects
    .map((object) => object.key)
    .filter((key) => Number(key.slice("previews/".length).split("/")[0]) <= cutoff);
  if (old.length > 0) await bucket.delete(old);
  const c = schema.previewCodes;
  const due = await db
    .select({ codeSha256: c.codeSha256 })
    .from(c)
    .where(lte(c.createdAt, cutoff))
    .limit(PRUNE_BATCH);
  if (due.length > 0) {
    await db.delete(c).where(
      inArray(
        c.codeSha256,
        due.map((row) => row.codeSha256),
      ),
    );
  }
  return old.length + due.length;
}
