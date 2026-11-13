// Built previews of edit suggestions on the preview origin (decision 0027, "Previews"). The app
// issues a one-use code for a stored plan to a person who may read the suggestion's thread; the
// content Worker redeems it on `preview.<content domain>`, re-checking the same rule, and answers
// with the document built here.
//
// What is computed when (pinned by the cost test in `test/suggestion-previews-review.test.ts`).
// At issue, 8 D1 calls and 3 R2 reads and 1 write for a Markdown document: the cached plan, the
// thread's read authorization, the two planning windows (counted after authorization, the windows
// dry runs and acceptances share), the stored file, rendering and block map in one read, whether
// the suggester still has an account, the plan rebuilt from them by the suggestion services' own
// builder (`suggestionPlanOf`; its digest must be the one the person holds), the preview built by
// the domain (`previewOfPlan`), one conditioned insert of the code row and the document written
// with the version and revision it shows. The cost is the plan's, bounded inside the planners by `PLAN_LIMITS`, and counted with
// dry runs in `PLANNING_RATE_LIMITS`. At redemption, 4 D1 calls with one region (one spend per
// region), 1 R2 read and 1 delete: the spend, the session with its account, the document (its
// metadata names what it shows), the thread's read authorization again (or for a draft or an
// unsaved edit, `previewOwnWork`), and the document compared with the current version and the
// revision it showed: no plan, no parse, no render.
//
// Only the code's SHA-256 is stored. A code is never logged, audited or written anywhere else.
import {
  DraftEdit,
  Edit,
  Plan,
  PREVIEW_CODES,
  previewHost,
  type UnsavedEdit,
} from "@portifact/contracts";
import { type Region, type RegionalDb, type Regions, schema } from "@portifact/db";
import { fail, logEvent, needsTermsAcceptance, ok, type Result } from "@portifact/domain";
import { previewOfPlan } from "@portifact/domain/suggestions";
import { DOCUMENT_RENDERER } from "@portifact/render";
import { and, eq, gt, inArray, isNull, lte, type SQL, sql } from "drizzle-orm";
import {
  type AuthorizedAnnotations,
  annotationParts,
  type CommentStanding,
  readableThread,
} from "./annotations.ts";
import { recordSessionRenewal } from "./read-access.ts";
import {
  admitPlanning,
  draftPlanOf,
  draftSubject,
  ownDraft,
  suggestionPlanOf,
  unsavedPlanOf,
} from "./suggestion-plans.ts";

type ThreadRow = typeof schema.annotationThreads.$inferSelect;
type DraftRow = typeof schema.editDrafts.$inferSelect;

interface PreviewCaller {
  userId: string;
  /** The dashboard session that asks; the code is redeemed only while it lives. */
  sessionId: string;
  artifactId: string;
  now: number;
  contentDomain: string;
}

/**
 * What a preview is of: a plan the person holds by its digest (`suggestion_plans`, cached per
 * person: a suggestion's, or their own draft's), or an edit nobody saved.
 */
export type PreviewIssueInput = PreviewCaller & ({ digest: string } | { unsaved: UnsavedEdit });

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
  // A service token takes no part in comments: `readableThread` gives it a missing thread.
  const readable = await readableThread(db, { ...input, threadId: subject.threadId });
  if (!readable.ok) return readable.code === "not_found" ? missingPlan() : readable;
  const { standing, thread } = readable.value;
  // Content is shown only while the artifact is: never archived or suspended (held or not).
  if (standing.state !== "active") return missingPlan();
  if (thread.kind !== "suggestion") return missingPlan();
  if (thread.suggestionState !== "pending") return planChanged();
  if (subject.revision !== null && thread.suggestionRevision !== subject.revision) {
    return planChanged();
  }
  return ok({ standing, thread });
}

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // 32 bytes are 43 base64 characters and one `=` of padding, dropped.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .slice(0, 43);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The seam for what is not a thread (decision 0027, "Previews"): one's own draft, and an edit
 * nobody saved. A draft is its author's only, while they act for the owner (`ownDraft`), not
 * being published, at the revision and incarnation the preview was built for; an unsaved
 * suggestion's edit is anyone's who may comment on the artifact now (`participate`), an unsaved
 * draft's the owner side's. Content is shown only while the artifact is active. A service token
 * takes no part in comments and gets a missing plan.
 */
export type OwnWork =
  | { kind: "draft"; revision: number | null; incarnation: string | null }
  | { kind: "unsaved"; as: UnsavedEdit["as"] };

export async function previewOwnWork(
  db: RegionalDb,
  input: { userId: string; artifactId: string; now: number },
  work: OwnWork,
): Promise<Result<{ loaded: AuthorizedAnnotations; draft: DraftRow | null }>> {
  const refused = <T>(result: Result<T> & { ok: false }) =>
    result.code === "not_found" ? missingPlan() : result;
  if (work.kind === "draft") {
    const found = await ownDraft(db, input, "read");
    if (!found.ok) return refused(found);
    const { loaded, draft } = found.value;
    if (loaded.state !== "active") return missingPlan();
    if (draft.attemptId !== null) return planChanged();
    if (
      (work.revision !== null && draft.revision !== work.revision) ||
      (work.incarnation !== null && draft.incarnation !== work.incarnation)
    ) {
      return planChanged();
    }
    return ok({ loaded, draft });
  }
  const action = work.as === "suggestion" ? "participate" : "moderate";
  const loaded = await annotationParts.authorize(db, input, action);
  if (!loaded.ok) return refused(loaded);
  if (work.as === "draft" && loaded.value.role !== "owner") return missingPlan();
  if (loaded.value.state !== "active") return missingPlan();
  return ok({ loaded: loaded.value, draft: null });
}

/** What a stored document was built against, travelling as its R2 metadata (no column). */
type DocumentSubject =
  | { subject: "thread"; versionId: string; revision: string }
  | { subject: "draft"; versionId: string; revision: string; incarnation: string }
  | { subject: "unsaved"; versionId: string; as: UnsavedEdit["as"] };

/**
 * Issues a one-use preview code for the caller's stored plan, or for an edit they have not
 * saved. Authorization comes first and a plan, thread, draft or artifact the caller may not see
 * answers like a missing one; then the planning rate limit; then the plan is built (a stored
 * plan rebuilt from the stored files, which must have the stored digest). A plan that applies
 * nothing, or whose page the builder refuses, answers `unavailable` with its reasons and issues
 * nothing: the viewer never shows the unchanged page as if it were changed.
 */
export async function issuePreviewCode(
  db: RegionalDb,
  bucket: R2Bucket,
  input: PreviewIssueInput,
): Promise<Result<IssuedPreview>> {
  if ("unsaved" in input) return issueUnsaved(db, bucket, input, input.unsaved);
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
  if (!row) return missingPlan();
  const parsed = Plan.safeParse(safeJson(row.plan));
  if (!parsed.success) return missingPlan();
  // The cached contents decide nothing by themselves: the plan rebuilt below from the stored
  // files must hash to the digest the person holds, so a tampered row only fails that check.
  const plan = parsed.data;
  if (row.threadId === null) return issueDraft(db, bucket, input, input.digest, plan);
  const { binding } = plan;
  const subject = await previewSubject(
    db,
    { userId, artifactId, now },
    { threadId: row.threadId, revision: binding.revision },
  );
  if (!subject.ok) return subject;
  const { standing, thread } = subject.value;

  // The same planning windows as dry runs and acceptances (`admitPlanning`).
  const admitted = await admitPlanning(db, userId, artifactId, now);
  if (!admitted.ok) return admitted;

  if (standing.artifact.currentVersionId !== binding.versionId) return planChanged();
  // Nothing applies: the plan says why, and nothing is read or built.
  if (plan.output === null) return ok(unavailable(plan));
  // Rebuilt by the one plan builder the suggestion services use (`suggestionPlanOf`: the stored
  // files read within their bounds, a carried suggestion at its carried positions, a stored byte
  // order mark kept), so a plan and its preview hash alike.
  const built = await suggestionPlanOf(db, bucket, {
    artifact: standing.artifact,
    thread,
    acceptor: standing.role === "owner",
    contentDomain: input.contentDomain,
  });
  if (!built.ok || built.value.plan.digest !== input.digest) return planChanged();
  const t = schema.annotationThreads;
  return storeCode(db, bucket, input, {
    ownerId: standing.artifact.ownerId,
    threadId: thread.id,
    plan: built.value.plan,
    still: sql`exists (select 1 from ${t} where ${t.id} = ${thread.id} and ${t.artifactId} = ${artifactId}
            and ${t.suggestionState} = 'pending' and ${t.suggestionRevision} = ${binding.revision})`,
    subject: {
      subject: "thread",
      versionId: binding.versionId,
      revision: String(binding.revision),
    },
  });
}

/** A plan's refusal reasons, when nothing of it applies. */
const unavailable = (plan: Pick<Plan, "listed">): IssuedPreview => ({
  state: "unavailable",
  reasons: plan.listed.map((e) => e.reason ?? "unknown"),
});

/** One's own draft's stored plan: the draft as it is, rebuilt and compared by digest. */
async function issueDraft(
  db: RegionalDb,
  bucket: R2Bucket,
  input: PreviewCaller,
  digest: string,
  plan: Plan,
): Promise<Result<IssuedPreview>> {
  const { userId, artifactId, now } = input;
  const { binding } = plan;
  if (binding.subject !== draftSubject(userId)) return missingPlan();
  const work = await previewOwnWork(
    db,
    { userId, artifactId, now },
    { kind: "draft", revision: binding.revision, incarnation: null },
  );
  if (!work.ok) return work;
  const { loaded } = work.value;
  const draft = work.value.draft as DraftRow;
  const admitted = await admitPlanning(db, userId, artifactId, now);
  if (!admitted.ok) return admitted;
  if (loaded.artifact.currentVersionId !== binding.versionId) return planChanged();
  if (draft.baseVersionId !== binding.versionId) return planChanged();
  if (plan.output === null) return ok(unavailable(plan));
  const built = await draftPlanOf(db, bucket, {
    artifact: loaded.artifact,
    draft,
    contentDomain: input.contentDomain,
  });
  if (!built.ok || built.value.plan.digest !== digest) return planChanged();
  const d = schema.editDrafts;
  return storeCode(db, bucket, input, {
    ownerId: loaded.artifact.ownerId,
    threadId: null,
    plan: built.value.plan,
    still: sql`exists (select 1 from ${d} where ${d.artifactId} = ${artifactId} and ${d.userId} = ${userId}
            and ${d.revision} = ${draft.revision} and ${d.incarnation} = ${draft.incarnation}
            and ${d.attemptId} is null)`,
    subject: {
      subject: "draft",
      versionId: binding.versionId,
      revision: String(draft.revision),
      incarnation: draft.incarnation,
    },
  });
}

/**
 * An edit nobody saved: validated like a saved one (`Edit` or `DraftEdit`), planned on the
 * artifact's current version and previewed, with nothing stored but the code and its document.
 */
async function issueUnsaved(
  db: RegionalDb,
  bucket: R2Bucket,
  input: PreviewCaller,
  unsaved: UnsavedEdit,
): Promise<Result<IssuedPreview>> {
  const { userId, artifactId, now } = input;
  const work = await previewOwnWork(
    db,
    { userId, artifactId, now },
    { kind: "unsaved", as: unsaved.as },
  );
  if (!work.ok) return work;
  const { loaded } = work.value;
  const parsed = (unsaved.as === "suggestion" ? Edit : DraftEdit).safeParse(unsaved.edit);
  if (!parsed.success) {
    return fail(
      "invalid_input",
      `Invalid edit: ${(parsed.error.issues[0] as { message: string }).message}`,
    );
  }
  if (loaded.artifact.currentVersionId !== unsaved.versionId) {
    return fail("version_conflict", "Edit the current version of the artifact.");
  }
  const admitted = await admitPlanning(db, userId, artifactId, now);
  if (!admitted.ok) return admitted;
  const built = await unsavedPlanOf(db, bucket, {
    artifact: loaded.artifact,
    userId,
    versionId: unsaved.versionId,
    edit: parsed.data,
    acceptor: loaded.role === "owner",
    contentDomain: input.contentDomain,
  });
  if (!built.ok) return built;
  if (built.value.plan.output === null) return ok(unavailable(built.value.plan));
  return storeCode(db, bucket, input, {
    ownerId: loaded.artifact.ownerId,
    threadId: null,
    plan: built.value.plan,
    still: sql`1`,
    subject: { subject: "unsaved", versionId: unsaved.versionId, as: unsaved.as },
  });
}

/**
 * Builds the preview of `plan` and stores it with a new code. One statement writes the code row,
 * and only while everything this request authorized and planned against still holds (AGENTS.md:
 * a write after an authorization is conditioned on the owner it read): the artifact's owner, its
 * active state and current version, and `still` (the suggestion or draft as planned). No row
 * means no document and no URL.
 */
async function storeCode(
  db: RegionalDb,
  bucket: R2Bucket,
  input: PreviewCaller,
  target: {
    ownerId: string;
    threadId: string | null;
    plan: Parameters<typeof previewOfPlan>[0];
    still: SQL;
    subject: DocumentSubject;
  },
): Promise<Result<IssuedPreview>> {
  const { userId, artifactId, now } = input;
  const preview = previewOfPlan(target.plan, DOCUMENT_RENDERER);
  if (preview.state === "unavailable") return ok(preview);
  const code = newCode();
  const codeSha256 = await sha256Hex(code);
  const r2Key = previewKey(now);
  const expiresAt = now + PREVIEW_CODES.ttlMs;
  const versionId = target.subject.versionId;
  const c = schema.previewCodes;
  const a = schema.artifacts;
  let inserted: { codeSha256: string }[];
  try {
    inserted = await db
      .insert(c)
      .select(
        sql`select ${codeSha256}, ${userId}, ${input.sessionId}, ${artifactId}, ${target.threadId}, ${r2Key}, ${now}, ${expiresAt}, null
          where exists (select 1 from ${a} where ${a.id} = ${artifactId} and ${a.ownerId} = ${target.ownerId}
            and ${a.state} = 'active' and (${a.expiresAt} is null or ${a.expiresAt} > ${now})
            and ${a.currentVersionId} = ${versionId})
          and ${target.still}`,
      )
      .returning({ codeSha256: c.codeSha256 });
  } catch (error) {
    if (causeIncludes(error, "preview_codes_limit")) {
      return fail("rate_limited", "Too many previews open. Wait a minute and try again.");
    }
    throw error;
  }
  if (inserted.length === 0) return planChanged();
  // The row first: a document is never stored without a row the scan can find. What the plan
  // was built against travels with the document (no column, no added call): a new version, a
  // revised suggestion or a saved draft before redemption makes the document stale.
  await bucket.put(r2Key, preview.document, { customMetadata: target.subject });
  return ok({
    state: "ready",
    url: `https://${previewHost(input.contentDomain)}${PREVIEW_CODES.pathPrefix}${code}`,
    expiresAt,
  });
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
  if (!found) return undefined;
  const { handles, row } = found;
  // The content Worker binds every region's bucket with its database.
  const bucket = handles.bucket as R2Bucket;
  try {
    // The dashboard session the code was issued to, with its account: a session of an account
    // that has not accepted the current terms counts as none (AGENTS.md, terms).
    const s = schema.sessions;
    const u = schema.users;
    const [session] = await regions.global
      .select({ termsVersion: u.termsVersion, createdAt: s.createdAt, method: s.signInMethod })
      .from(s)
      .innerJoin(u, eq(u.id, s.userId))
      .where(and(eq(s.id, row.sessionId), eq(s.userId, row.userId), gt(s.expiresAt, new Date(now))))
      .limit(1);
    if (!session || needsTermsAcceptance(session.termsVersion)) return undefined;
    // That session is how this request authenticates the person (decision 0021): its sign-in,
    // from the row just read and never from input, binds a workspace's sign-in policies.
    recordSessionRenewal(handles.db, row.userId, {
      signedInAt: session.createdAt.getTime(),
      method: session.method,
    });
    const object = await bucket.get(row.r2Key);
    if (!object) return undefined;
    // The subject the document shows must still be the one in force: re-checked by the same
    // rule that issued it, against what it was built for (its metadata).
    const planned = (object.customMetadata ?? {}) as Partial<Record<string, string>>;
    const who = { userId: row.userId, artifactId: row.artifactId, now };
    if (!(await stillShown(handles.db, who, row.threadId, planned))) {
      await object.body.cancel();
      return undefined;
    }
    return await object.text();
  } finally {
    // A spent code's document is never needed again, whatever the answer.
    await bucket.delete(row.r2Key);
  }
}

/** Whether a spent code's document may still be shown to its person (see `redeemPreviewCode`). */
async function stillShown(
  db: RegionalDb,
  who: { userId: string; artifactId: string; now: number },
  threadId: string | null,
  planned: Partial<Record<string, string>>,
): Promise<boolean> {
  if (planned.subject === "draft") {
    const work = await previewOwnWork(db, who, {
      kind: "draft",
      revision: Number(planned.revision),
      incarnation: planned.incarnation ?? "",
    });
    return (
      work.ok &&
      work.value.loaded.artifact.currentVersionId === planned.versionId &&
      work.value.draft?.baseVersionId === planned.versionId
    );
  }
  if (planned.subject === "unsaved") {
    if (planned.as !== "suggestion" && planned.as !== "draft") return false;
    const work = await previewOwnWork(db, who, { kind: "unsaved", as: planned.as });
    return work.ok && work.value.loaded.artifact.currentVersionId === planned.versionId;
  }
  // A suggestion's thread: the column clears only with the thread's cascade.
  const subject = await previewSubject(db, who, { threadId: threadId ?? "", revision: null });
  if (!subject.ok) return false;
  const { standing, thread } = subject.value;
  return (
    planned.versionId === standing.artifact.currentVersionId &&
    planned.revision === String(thread.suggestionRevision)
  );
}

/**
 * What one prune run may do per region (`pageSize` objects or rows per call, `pages` calls of
 * each): R2 lists and deletes at most 1,000 keys a call, and a D1 delete of 1,000 rows by key is
 * one short statement with two bound values. Five pages are 5,000 documents and 5,000 rows a
 * minute per region. The planning rate limits are per person, so they do not bound a region's
 * total: a run that reaches the cap says so, and the operator investigates if it keeps happening.
 */
export const PREVIEW_PRUNE = { pageSize: 1_000, pages: 5 } as const;

/** The internal cache key of a document built at `now`: `previews/<time>/<random>`. */
export function previewKey(now: number): string {
  return `previews/${now}/${crypto.randomUUID()}`;
}

/** What one prune run did in one region; `behind` when it reached its cap, so more may remain. */
export interface PreviewPrune {
  documents: number;
  rows: number;
  behind: boolean;
}

/** The creation time a cached document's key starts with. */
const keyTime = (key: string) => Number(key.slice("previews/".length).split("/")[0]);

/**
 * Deletes cached preview documents and preview codes once they are `PREVIEW_CODES.documentTtlMs`
 * old, redeemed or not; it runs every minute on the jobs Worker (while suggestions are on) and in
 * every maintenance run. Documents are found by their key, which starts with their creation time
 * and so sorts oldest first, so a document whose row went another way (an account deletion
 * deletes the rows) is still deleted. Rows are reached through the `expires_at` index: a code's
 * expiry is always its creation plus `PREVIEW_CODES.ttlMs`, so a row created at or before the
 * cutoff expires at or before `cutoff + ttlMs`, and each statement reads only the rows it
 * deletes. A run keeps going while its last page was full, up to its cap, and says so once when
 * it reaches it: more may remain, or the cap was exactly enough.
 */
export async function prunePreviewCodes(
  db: RegionalDb,
  bucket: R2Bucket,
  now: number,
  limits: { pageSize: number; pages: number } = PREVIEW_PRUNE,
  region: Region = "default",
): Promise<PreviewPrune> {
  const cutoff = now - PREVIEW_CODES.documentTtlMs;
  let documents = 0;
  let documentsBehind = false;
  for (let page = 0; page < limits.pages; page++) {
    const listed = await bucket.list({ prefix: "previews/", limit: limits.pageSize });
    const old = listed.objects.map((object) => object.key).filter((key) => keyTime(key) <= cutoff);
    if (old.length > 0) await bucket.delete(old);
    documents += old.length;
    // A young key ends the old ones; a short listing ends the prefix.
    const more = old.length === listed.objects.length && listed.truncated;
    if (!more) break;
    documentsBehind = page === limits.pages - 1;
  }
  const c = schema.previewCodes;
  let rows = 0;
  let rowsBehind = false;
  for (let page = 0; page < limits.pages; page++) {
    const deleted = await db
      .delete(c)
      .where(
        inArray(
          c.codeSha256,
          db
            .select({ codeSha256: c.codeSha256 })
            .from(c)
            .where(lte(c.expiresAt, cutoff + PREVIEW_CODES.ttlMs))
            .limit(limits.pageSize),
        ),
      )
      .returning({ codeSha256: c.codeSha256 });
    rows += deleted.length;
    if (deleted.length < limits.pageSize) break;
    rowsBehind = page === limits.pages - 1;
  }
  const behind = documentsBehind || rowsBehind;
  if (behind) logEvent("warn", "preview_prune_behind", { region, documents, rows });
  return { documents, rows, behind };
}
