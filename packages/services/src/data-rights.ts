// A person's rights over what they saved in artifacts (decision 0026, "The grant" and "Moderation
// and law"): from "Data you shared" on the app, the person exports and deletes the documents they
// created, as the visitor the author journal names them in that artifact. Both go to the
// documents object as the page's own export and delete do (`pageDataCommand`), charged to the
// visitor's rights class, so they need neither write permission, the current terms, an open
// grant nor read access to the artifact: the documents are the person's. Nothing here reads or
// changes anyone else's documents, and a person the journal does not name has nothing to export.
import {
  JournalEntry as JournalEntrySchema,
  type PageDataCommand,
} from "@portifact/contracts/artifact-data";
import type { LocaleCode } from "@portifact/contracts/locales";
import { hitRateLimit, type RegionalDb, schema } from "@portifact/db";
import { checkNoticeCapacity, fail, logEvent, ok, type Result } from "@portifact/domain";
import { journalKey } from "@portifact/domain/artifact-data";
import { and, eq, inArray } from "drizzle-orm";
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

/** One page of the documents the person created in the artifact, as the export stores them. */
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

export type DataRightsKind = "access" | "erasure";

/** Requests one person may send about one artifact a day. */
export const DATA_RIGHTS_REQUESTS_PER_DAY = 3;
const DAY_MS = 86_400_000;

/**
 * The person asks the people who manage an artifact for a copy of, or the erasure of, what they
 * saved there (decision 0026, "Moderation and law"). Only a person the journal names in the
 * artifact may ask; a few requests a day per person and artifact. Writes one `data_rights_request`
 * job in the artifact's region, which names the person only by their visitor ID.
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
  await db.insert(schema.outbox).values({
    topic: "data_rights_request",
    payload: { visitorId, kind: input.kind },
    availableAt: input.now,
    createdAt: input.now,
    subject: input.artifactId,
  });
  return ok({ requested: true });
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

function rightsPayload(payload: unknown): { visitorId: string; kind: DataRightsKind } | null {
  const value = (typeof payload === "string" ? JSON.parse(payload) : payload) as {
    visitorId?: unknown;
    kind?: unknown;
  } | null;
  if (typeof value?.visitorId !== "string") return null;
  if (value.kind !== "access" && value.kind !== "erasure") return null;
  return { visitorId: value.visitorId, kind: value.kind };
}

/**
 * Runs a `data_rights_request` job: claims its row by deleting it, then emails each admin of the
 * artifact's owner (`ownerRecipients`), skipping suppressed addresses and stopping at the notice
 * capacity. A send that fails after another admin got it is dropped, never retried, like expiry
 * notices; one failing first puts the row back.
 */
export async function sendDataRightsNotice(
  db: RegionalDb,
  row: typeof schema.outbox.$inferSelect,
  now: number,
  notifier: DataRightsNotifier,
): Promise<JobOutcome> {
  const claimed = await db
    .delete(schema.outbox)
    .where(eq(schema.outbox.id, row.id))
    .returning({ id: schema.outbox.id });
  if (claimed.length === 0) return "done";
  const request = rightsPayload(row.payload);
  const artifactId = row.subject ?? "";
  const [artifact] = await db
    .select({ name: schema.artifacts.name, ownerId: schema.artifacts.ownerId })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId))
    .limit(1);
  if (request === null || !artifact) {
    logEvent("log", "data_rights_notice_skipped", { reason: "gone" });
    return "stale";
  }
  const global = db.global;
  const [workspace] = await global
    .select({ slug: schema.workspaces.slug })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, artifact.ownerId))
    .limit(1);
  let sent = 0;
  for (const userId of await ownerRecipients(global, artifact.ownerId)) {
    if (!checkNoticeCapacity(await emailsSentInCycle(global, now)).ok) {
      logEvent("log", "data_rights_notice_skipped", { reason: "capacity" });
      break;
    }
    const [person] = await global
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!person || (await isEmailSuppressed(global, person.email, now))) continue;
    try {
      await notifier.send({
        to: person.email,
        kind: request.kind,
        artifactId,
        artifactName: artifact.name,
        visitorId: request.visitorId,
        workspaceSlug: workspace?.slug ?? null,
        locale: (await loadSettings(global, userId)).locale,
      });
    } catch (error) {
      if (error instanceof RecipientSuppressedError) {
        await suppressEmail(global, { email: person.email, reason: "provider", now });
        continue;
      }
      if (sent > 0) {
        logEvent("log", "data_rights_notice_skipped", { reason: "partial" });
        return "done";
      }
      await db.insert(schema.outbox).values({
        topic: "data_rights_request",
        payload: request,
        availableAt: now,
        createdAt: row.createdAt,
        subject: artifactId,
        attempts: row.attempts,
      });
      throw error;
    }
    await recordEmailsSent(global, now);
    sent += 1;
  }
  return "done";
}
