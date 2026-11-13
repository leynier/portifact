// The page side of artifact data (decision 0026, delivery 6): what the artifact's own JavaScript
// reads and writes from a visitor's browser, through the content Worker's routes under
// `/__portifact/data/`. The content Worker has already applied the API gate, found the artifact
// servable, authorized the reading session, applied the network policy, the traffic quota and
// budget protection's traffic steps, and decided the caller: a grant holder by their visitor ID
// (`renewDataGrant`), or a reader without one. This sends the command to the artifact's documents
// object with the envelope from D1 and the owner plan's limits; the object admits, authorizes by
// the collection's mode and charges it. Writes pass budget protection's data step first.
//
// It writes nothing in D1: the storage report each answer carries is returned for the content
// Worker to batch (no D1 write per delivery request), and nothing creates an object: an artifact
// without an `artifact_data` row has no data, so its commands answer `not_found`.
import type {
  ArtifactDataLimits,
  PageCaller,
  PageDataCommand,
  StorageReport,
} from "@portifact/contracts/artifact-data";
import type { RegionalDb } from "@portifact/db";
import { type DataWork, dataRefusalError, fail, ok, type Result } from "@portifact/domain";
import { type DataObjects, readDataRow } from "./artifact-data.ts";
import { checkDataWriteCapacity } from "./budget.ts";

export interface PageDataDeps {
  /** The artifact's region's objects; null without the binding. */
  objects: DataObjects | null;
  /**
   * `DATA_PAGE_WRITES_ENABLED` is exactly `"true"` (decision 0026, "Switches"): off, the page's
   * creates and replacements answer `capacity_unavailable`, while reads, the visitor's own
   * deletes and their export go on.
   */
  pageWrites: boolean;
}

/** Whether the page-write switch is on: only exactly `"true"`. */
export function pageWritesEnabled(env: { DATA_PAGE_WRITES_ENABLED?: string | undefined }): boolean {
  return env.DATA_PAGE_WRITES_ENABLED === "true";
}

/** The page commands the page-write switch stops. */
const SWITCHED_WRITES = new Set<PageDataCommand["kind"]>(["create", "replace"]);

export interface PageDataInput {
  artifactId: string;
  /** The region holding the artifact, as the directory says. */
  region: string;
  /** The owner plan's per-artifact limits (the delivery lookup holds the plan). */
  limits: ArtifactDataLimits;
  caller: PageCaller;
  command: PageDataCommand;
  /**
   * The page's idempotency key on a mutation (`Idempotency-Key`), or null. A key of the form
   * `<issue time in ms, 13 digits>.<random>` (the client script's) names one operation however
   * late it is retried; any other is a new operation each time.
   */
  idempotencyKey: string | null;
  now: number;
}

export interface PageDataAnswer {
  value: unknown;
  replayed: boolean;
}

/** What each page command is to budget protection's data step. */
const PAGE_WORK: Record<PageDataCommand["kind"], DataWork> = {
  get: "get",
  query: "query",
  create: "create",
  replace: "replace",
  remove: "remove",
  export_mine: "export_page",
};

const MUTATIONS = new Set<PageDataCommand["kind"]>(["create", "replace", "remove"]);

const KEYED = /^([0-9]{13})\.[A-Za-z0-9_-]{8,64}$/;

/**
 * A page mutation's operation ID, without a D1 write: the issue time the page's key carries (or
 * now, for a key of another form or none) and a hash of the caller and the key, so the object's
 * own record applies a retried change once. The object refuses an issue time older than its
 * horizon or ahead of its clock by more than the skew, so the page cannot pick a time to dodge it.
 */
export async function pageOperationId(
  author: string,
  key: string | null,
  now: number,
): Promise<string> {
  const keyed = key === null ? null : KEYED.exec(key);
  const material = keyed ? key : `${key ?? ""}\u0000${crypto.randomUUID()}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${author}\u0000${material}`),
  );
  const hex = [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const issued = keyed ? (keyed[1] as string) : String(Math.floor(now)).padStart(13, "0");
  return `${issued}.${hex}`;
}

const noData = () => fail<never>("not_found", "This artifact has no data.");

type Answer =
  | { ok: true; value?: unknown; replayed?: unknown; storage: StorageReport }
  | { ok: false; code: string; message: string; storage?: StorageReport };

/**
 * Runs one page command. Answers the command's value and the object's storage report (null when
 * the object was not reached), which the content Worker keeps to write in a batch.
 */
export async function pageDataCommand(
  db: RegionalDb,
  deps: PageDataDeps,
  input: PageDataInput,
): Promise<{ result: Result<PageDataAnswer>; storage: StorageReport | null }> {
  const row = await readDataRow(db, input.region, input.artifactId);
  if (row === null) return { result: noData(), storage: null };
  if (deps.objects === null) {
    return {
      result: fail("capacity_unavailable", "Artifact data is unavailable. Try again later."),
      storage: null,
    };
  }
  if (!deps.pageWrites && SWITCHED_WRITES.has(input.command.kind)) {
    return {
      result: fail("capacity_unavailable", "Saving from pages is paused. Try again later."),
      storage: null,
    };
  }
  const capacity = await checkDataWriteCapacity(
    db.global,
    PAGE_WORK[input.command.kind],
    input.now,
  );
  if (!capacity.ok) return { result: capacity, storage: null };
  const mutation = MUTATIONS.has(input.command.kind);
  const author = input.caller.kind === "visitor" ? input.caller.author : "reader";
  const opId = mutation
    ? await pageOperationId(author, input.idempotencyKey, input.now)
    : undefined;
  const envelope = {
    artifactId: input.artifactId,
    region: row.region,
    ownerId: row.ownerId,
    generation: row.generation,
    epoch: row.epoch,
    ...(opId === undefined ? {} : { opId }),
  };
  const answer = (await deps.objects
    .object(input.artifactId)
    .pageCommand(envelope, input.caller, input.command, input.limits, input.now)) as Answer;
  const storage = answer.storage ?? null;
  if (!answer.ok) {
    const error = dataRefusalError(answer.code, answer.message);
    return { result: fail(error.code, error.message), storage };
  }
  return {
    result: ok({
      value: "replayed" in answer ? answer.replayed : answer.value,
      replayed: "replayed" in answer,
    }),
    storage,
  };
}
