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
import type { RegionalDb } from "@portifact/db";
import { fail, ok, type Result } from "@portifact/domain";
import { journalKey } from "@portifact/domain/artifact-data";
import { type DataObjects, readDataRow } from "./artifact-data.ts";
import { type PageDataAnswer, pageDataCommand } from "./artifact-data-page.ts";
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
    { objects: deps.objects },
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
