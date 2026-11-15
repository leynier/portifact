// A person's rights over what they saved in artifacts (decision 0026, "The grant" and "Moderation
// and law"): from "Data you shared" on the app, the person exports and deletes the documents they
// created, as the visitor the author journal names them in that artifact. Both go to the
// documents object as the page's own export and delete do (`pageDataCommand`), charged to the
// visitor's rights class, so they need neither write permission, the current terms, an open
// grant nor read access to the artifact: the documents are the person's. Nothing here reads or
// changes anyone else's documents, and a person the journal does not name has nothing to export.

import type { OwnErasureView } from "@portifact/contracts";
import {
  JournalEntry as JournalEntrySchema,
  type PageDataCommand,
} from "@portifact/contracts/artifact-data";
import type { LocaleCode } from "@portifact/contracts/locales";
import { hitRateLimit, type RegionalDb, schema } from "@portifact/db";
import { checkNoticeCapacity, fail, logEvent, ok, type Result } from "@portifact/domain";
import { journalKey } from "@portifact/domain/artifact-data";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { loadSettings } from "./account-settings.ts";
import { ownerRecipients } from "./actors.ts";
import { type DataObjects, readDataRow } from "./artifact-data.ts";
import { type PageDataAnswer, pageDataCommand } from "./artifact-data-page.ts";
import {
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "./email.ts";
import type { JobOutcome } from "./outbox.ts";
import { ownerEntitlements } from "./plans.ts";

export interface DataRightsDeps {
  /** The artifact's region's objects; null without the binding. */
  objects: DataObjects | null;
  /** The artifact's region's bucket, which holds the author journal. */
  bucket: R2Bucket;
}

export interface DataRightsInput {
  userId: string;
  artifactId: string;
  /** The region holding the artifact, as the directory says. */
  region: string;
  now: number;
}

const nothing = () => fail<never>("not_found", "You saved nothing in this artifact.");

/**
 * The visitor ID the journal names the person by in an artifact, or null: none claimed, or
 * retired (the account is being deleted, and its documents with it).
 */
export async function journalVisitorId(
  bucket: R2Bucket,
  userId: string,
  artifactId: string,
): Promise<string | null> {
  const found = await bucket.get(journalKey(userId, artifactId));
  if (found === null) return null;
  const entry = JournalEntrySchema.safeParse(await found.json());
  if (!entry.success || entry.data.retiredAt !== undefined) return null;
  return entry.data.visitorId;
}

async function asVisitor(
  db: RegionalDb,
  deps: DataRightsDeps,
  input: DataRightsInput,
  command: PageDataCommand,
  idempotencyKey: string | null,
): Promise<Result<PageDataAnswer>> {
  const visitorId = await journalVisitorId(deps.bucket, input.userId, input.artifactId);
  if (visitorId === null) return nothing();
  const row = await readDataRow(db, input.region, input.artifactId);
  if (row === null) return nothing();
  // The owner's plan sets the artifact's limits, never the person's.
  const limits = (await ownerEntitlements(db.global, row.ownerId, input.now)).data.perArtifact;
  const { result } = await pageDataCommand(
    db,
    // Exports and deletes are never paused with page writes.
    { objects: deps.objects, pageWrites: false },
    {
      artifactId: input.artifactId,
      region: input.region,
      limits,
      // `canWrite` is false: a person's own export and deletes never need it.
      caller: { kind: "visitor", author: visitorId, canWrite: false },
      command,
      idempotencyKey,
      now: input.now,
    },
  );
  return result;
}

/**
 * One page of the documents the person created in the artifact, as the export stores them. Each
 * page is charged to the person's own rights allowance, which a large export spends within a day;
 * the next page is then refused `rate_limited` until the allowance comes back, and the export
 * resumes from its cursor.
 */
export async function exportOwnData(
  db: RegionalDb,
  deps: DataRightsDeps,
  input: DataRightsInput & { after: { collection: string; id: string } | null },
): Promise<Result<unknown>> {
  const answer = await asVisitor(
    db,
    deps,
    input,
    { kind: "export_mine", after: input.after },
    null,
  );
  return answer.ok ? ok(answer.value.value) : answer;
}

/** Deletes one document the person created. A retry with the same key deletes it once. */
export async function deleteOwnDocument(
  db: RegionalDb,
  deps: DataRightsDeps,
  input: DataRightsInput & { collection: string; id: string; idempotencyKey: string | null },
): Promise<Result<{ deleted: true }>> {
  const answer = await asVisitor(
    db,
    deps,
    input,
    { kind: "remove", collection: input.collection, id: input.id },
    input.idempotencyKey,
  );
  return answer.ok ? ok({ deleted: true }) : answer;
}

/** Erasures one person may start in one artifact a day (each runs to the end on its own). */
export const OWN_ERASURES_PER_DAY = 5;

type OwnErasureRow = typeof schema.dataOwnErasures.$inferSelect;

/** An erasure row as "Data you shared" shows it. */
export function ownErasureView(row: OwnErasureRow): OwnErasureView {
  return {
    state: row.state,
    documents: row.documents,
    edits: row.edits,
    requestedAt: new Date(row.requestedAt).toISOString(),
    finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt).toISOString(),
  };
}

/**
 * The person asks to delete everything they saved in the artifact (decision 0026, "A person's
 * rights"): the documents they created, with later edits others made to them, and their name on
 * their edits to other people's documents. It is not their single-document delete: the
 * `data_own_erasure` job runs it on the documents object in bounded chunks of protected work, so
 * neither their daily rights allowance nor the artifact's budget or a capacity pause stops it, and
 * it finishes within the hour for any dataset a plan allows. Only a person the journal names may
 * ask; a running erasure answers as it is, without starting another. The row and its job are
 * written in one batch, the job only when this request's `write_id` holds the row.
 */
export async function requestOwnErasure(
  db: RegionalDb,
  bucket: R2Bucket,
  input: DataRightsInput,
): Promise<Result<OwnErasureView>> {
  const visitorId = await journalVisitorId(bucket, input.userId, input.artifactId);
  if (visitorId === null) return nothing();
  if ((await readDataRow(db, input.region, input.artifactId)) === null) return nothing();
  const e = schema.dataOwnErasures;
  const key = and(eq(e.artifactId, input.artifactId), eq(e.visitorId, visitorId));
  const [existing] = await db.select().from(e).where(key).limit(1);
  if (existing?.state === "running") return ok(ownErasureView(existing));
  const hits = await hitRateLimit(
    db.global.$client,
    `own_erasure:${input.userId}:${input.artifactId}`,
    DAY_MS,
    input.now,
  );
  if (hits.count > OWN_ERASURES_PER_DAY) {
    return fail("rate_limited", "You asked for this several times today. Try again tomorrow.");
  }
  const writeId = crypto.randomUUID().replaceAll("-", "");
  const payload = JSON.stringify({ visitorId, writeId });
  await db.batch([
    db
      .insert(e)
      .values({
        artifactId: input.artifactId,
        visitorId,
        state: "running",
        writeId,
        documents: 0,
        edits: 0,
        requestedAt: input.now,
        finishedAt: null,
      })
      .onConflictDoUpdate({
        target: [e.artifactId, e.visitorId],
        set: {
          state: "running",
          writeId,
          documents: 0,
          edits: 0,
          requestedAt: input.now,
          finishedAt: null,
        },
        setWhere: sql`${e.state} <> 'running'`,
      }),
    db
      .insert(schema.outbox)
      .select(
        sql`select null, 'data_own_erasure', ${payload}, ${input.now}, null, 0, ${input.now}, ${input.artifactId}, null where exists (select 1 from ${e} where ${e.artifactId} = ${input.artifactId} and ${e.visitorId} = ${visitorId} and ${e.writeId} = ${writeId})`,
      ),
  ]);
  const [row] = await db.select().from(e).where(key).limit(1);
  if (!row) return nothing();
  return ok(ownErasureView(row));
}

export type DataRightsKind = "access" | "erasure";

/** Requests one person may send about one artifact a day. */
export const DATA_RIGHTS_REQUESTS_PER_DAY = 3;
const DAY_MS = 86_400_000;

/** Delivered and resolved requests are kept this long, then pruned. */
export const DATA_RIGHTS_KEEP_MS = 30 * DAY_MS;

/**
 * The person asks the people who manage an artifact for a copy of, or the erasure of, what they
 * saved there (decision 0026, "Moderation and law"). Only a person the journal names in the
 * artifact may ask; a few requests a day per person and artifact. Writes the request, which names
 * the person only by their visitor ID, and its `data_rights_request` job in one batch in the
 * artifact's region. The answer means the request was received and kept, not that anyone was
 * emailed yet: the job delivers it, waiting out a spent email cycle, and a request nobody can be
 * emailed about stays for the operator.
 */
export async function requestDataRights(
  db: RegionalDb,
  bucket: R2Bucket,
  input: DataRightsInput & { kind: DataRightsKind },
): Promise<Result<{ requested: true }>> {
  const visitorId = await journalVisitorId(bucket, input.userId, input.artifactId);
  if (visitorId === null) return nothing();
  const [artifact] = await db
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.id, input.artifactId),
        inArray(schema.artifacts.state, ["active", "archived", "suspended"]),
      ),
    )
    .limit(1);
  if (!artifact) return nothing();
  const hits = await hitRateLimit(
    db.global.$client,
    `data_rights:${input.userId}:${input.artifactId}`,
    DAY_MS,
    input.now,
  );
  if (hits.count > DATA_RIGHTS_REQUESTS_PER_DAY) {
    return fail("rate_limited", "You sent this request already today. Try again tomorrow.");
  }
  const id = `dr_${crypto.randomUUID().replaceAll("-", "")}`;
  await db.batch([
    db.insert(schema.dataRightsRequests).values({
      id,
      artifactId: input.artifactId,
      visitorId,
      kind: input.kind,
      state: "pending",
      createdAt: input.now,
    }),
    rightsJob(db, id, input.now),
  ]);
  return ok({ requested: true });
}

function rightsJob(db: RegionalDb, requestId: string, now: number) {
  return db.insert(schema.outbox).values({
    topic: "data_rights_request",
    payload: {},
    availableAt: now,
    createdAt: now,
    subject: requestId,
  });
}

/** Sends the email; the jobs Worker renders it, naming the artifact only where its region may. */
export interface DataRightsNotifier {
  send(notice: {
    to: string;
    kind: DataRightsKind;
    artifactId: string;
    artifactName: string;
    visitorId: string;
    workspaceSlug: string | null;
    locale: LocaleCode | null;
  }): Promise<void>;
}

type Skip = "gone" | "capacity" | "suppressed" | "undeliverable";

// Only the reason: never the address, the visitor ID or the artifact.
function skipped(reason: Skip): void {
  logEvent("log", "data_rights_notice_skipped", { reason });
}

/**
 * Runs a `data_rights_request` job: emails each admin of the artifact's owner (`ownerRecipients`)
 * not emailed yet, claiming each send in `data_rights_request_sends` before it and giving it back
 * when it fails, so a retry never emails an admin twice. A spent notice capacity leaves the job
 * `pending`, delivered again later; a failed send throws, so the job runs again. Once every admin
 * was tried the request is `delivered` (someone got it) or `undeliverable` (every address
 * suppressed, or no admin), which keeps it for the operator; its send claims go then.
 */
export async function sendDataRightsNotice(
  db: RegionalDb,
  row: typeof schema.outbox.$inferSelect,
  now: number,
  notifier: DataRightsNotifier,
): Promise<JobOutcome> {
  const r = schema.dataRightsRequests;
  const s = schema.dataRightsRequestSends;
  const [request] = await db
    .select()
    .from(r)
    .where(eq(r.id, row.subject ?? ""))
    .limit(1);
  // Settled meanwhile, or gone with its artifact.
  if (!request || request.state !== "pending") return "stale";
  const [artifact] = await db
    .select({ name: schema.artifacts.name, ownerId: schema.artifacts.ownerId })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, request.artifactId))
    .limit(1);
  if (!artifact) {
    skipped("gone");
    return "stale";
  }
  const global = db.global;
  const [workspace] = await global
    .select({ slug: schema.workspaces.slug })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, artifact.ownerId))
    .limit(1);
  const already = new Set(
    (await db.select({ userId: s.userId }).from(s).where(eq(s.requestId, request.id))).map(
      (sent) => sent.userId,
    ),
  );
  const recipients = await ownerRecipients(global, artifact.ownerId);
  for (const userId of recipients) {
    if (already.has(userId)) continue;
    const [person] = await global
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!person) continue;
    if (await isEmailSuppressed(global, person.email, now)) {
      skipped("suppressed");
      continue;
    }
    if (!checkNoticeCapacity(await emailsSentInCycle(global, now)).ok) {
      // Kept for a later delivery, which emails only the admins not told yet.
      skipped("capacity");
      return "pending";
    }
    const claimed = await db
      .insert(s)
      .values({ requestId: request.id, userId, sentAt: now })
      .onConflictDoNothing()
      .returning({ userId: s.userId });
    if (claimed.length === 0) continue;
    const giveBack = () =>
      db.delete(s).where(and(eq(s.requestId, request.id), eq(s.userId, userId)));
    try {
      await notifier.send({
        to: person.email,
        kind: request.kind,
        artifactId: request.artifactId,
        artifactName: artifact.name,
        visitorId: request.visitorId,
        workspaceSlug: workspace?.slug ?? null,
        locale: (await loadSettings(global, userId)).locale,
      });
    } catch (error) {
      await giveBack();
      if (error instanceof RecipientSuppressedError) {
        await suppressEmail(global, { email: person.email, reason: "provider", now });
        skipped("suppressed");
        continue;
      }
      throw error;
    }
    await recordEmailsSent(global, now);
    already.add(userId);
  }
  const [count] = await db
    .select({ count: sql<number>`count(*)` })
    .from(s)
    .where(eq(s.requestId, request.id));
  const sent = Number(count?.count ?? 0);
  if (sent === 0) skipped("undeliverable");
  const pending = and(eq(r.id, request.id), eq(r.state, "pending"));
  await db.batch([
    db
      .update(r)
      .set({
        state: sent > 0 ? "delivered" : "undeliverable",
        reason: sent > 0 ? null : recipients.length === 0 ? "no_recipient" : "suppressed",
        recipients: sent,
        settledAt: now,
      })
      .where(pending),
    // The claims only kept a retry from emailing anyone twice: they go once it settled.
    db
      .delete(s)
      .where(
        and(
          eq(s.requestId, request.id),
          sql`exists (select 1 from ${r} where ${r.id} = ${request.id} and ${r.state} <> 'pending')`,
        ),
      ),
  ]);
  return "done";
}

/** A rights request as the operator tool lists it: no address, only the visitor ID. */
export interface DataRightsRequestView {
  id: string;
  artifactId: string;
  kind: DataRightsKind;
  state: "pending" | "undeliverable";
  reason: string | null;
  visitorId: string;
  createdAt: number;
}

/**
 * The requests the operator must look at in one region: every `undeliverable` one, and those
 * still `pending` a day after they were made (the email cycle is spent, or sends keep failing),
 * oldest first.
 */
export async function listDataRightsRequests(
  db: RegionalDb,
  now: number,
  limit = 50,
): Promise<DataRightsRequestView[]> {
  const r = schema.dataRightsRequests;
  const rows = await db
    .select({
      id: r.id,
      artifactId: r.artifactId,
      kind: r.kind,
      state: r.state,
      reason: r.reason,
      visitorId: r.visitorId,
      createdAt: r.createdAt,
    })
    .from(r)
    .where(
      or(eq(r.state, "undeliverable"), and(eq(r.state, "pending"), lte(r.createdAt, now - DAY_MS))),
    )
    .orderBy(asc(r.createdAt), asc(r.id))
    .limit(Math.min(Math.max(1, limit), 500));
  return rows as DataRightsRequestView[];
}

/**
 * The operator handled a request another way (for example by writing to the managers) and marks
 * it `resolved`; a pending one's job then ends without emailing. False when the request is not
 * there or already delivered or resolved.
 */
export async function resolveDataRightsRequest(
  db: RegionalDb,
  id: string,
  now: number,
): Promise<boolean> {
  const r = schema.dataRightsRequests;
  const done = await db
    .update(r)
    .set({ state: "resolved", settledAt: now })
    .where(and(eq(r.id, id), inArray(r.state, ["pending", "undeliverable"])))
    .returning({ id: r.id });
  return done.length > 0;
}

/**
 * Tries an `undeliverable` request again, after the operator lifted a suppression or the owner
 * gained an admin: back to `pending` with a new job, in one batch conditioned on the state read.
 */
export async function retryDataRightsRequest(
  db: RegionalDb,
  id: string,
  now: number,
): Promise<boolean> {
  const r = schema.dataRightsRequests;
  const undeliverable = and(eq(r.id, id), eq(r.state, "undeliverable"));
  const [found] = await db.select({ id: r.id }).from(r).where(undeliverable).limit(1);
  if (!found) return false;
  const [, retried] = await db.batch([
    db
      .insert(schema.outbox)
      .select(
        sql`select null, 'data_rights_request', '{}', ${now}, null, 0, ${now}, ${id}, null where exists (select 1 from ${r} where ${r.id} = ${id} and ${r.state} = 'undeliverable')`,
      ),
    db
      .update(r)
      .set({ state: "pending", reason: null, settledAt: null })
      .where(undeliverable)
      .returning({ id: r.id }),
  ]);
  return retried.length > 0;
}

/**
 * Deletes, at most `limit` of each per run, delivered and resolved requests and finished own
 * erasures `DATA_RIGHTS_KEEP_MS` after they settled, each through its `(state, time)` index, in
 * one batch. Pending and undeliverable requests and running erasures stay.
 */
export async function pruneDataRightsRequests(
  db: RegionalDb,
  now: number,
  limit = 500,
): Promise<{ processed: number }> {
  const r = schema.dataRightsRequests;
  const e = schema.dataOwnErasures;
  const before = now - DATA_RIGHTS_KEEP_MS;
  const [requests, erasures] = await db.batch([
    db
      .delete(r)
      .where(
        sql`${r.id} in (select ${r.id} from ${r} where ${r.state} in ('delivered', 'resolved') and ${r.settledAt} <= ${before} limit ${limit})`,
      )
      .returning({ id: r.id }),
    db
      .delete(e)
      .where(
        sql`rowid in (select rowid from ${e} where ${e.state} in ('done', 'failed') and ${e.finishedAt} <= ${before} limit ${limit})`,
      )
      .returning({ id: e.artifactId }),
  ]);
  return { processed: requests.length + erasures.length };
}
