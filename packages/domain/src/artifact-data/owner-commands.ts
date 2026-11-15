// Which method of a documents object an owner-side command runs (decision 0026, delivery 5): one
// dispatch, shared by the real object (`ownerCommand` in apps/data) and the in-memory reference
// the services' tests drive, so both answer an owner command through the same method.
import type {
  ArtifactDataLimits,
  BulkCreate,
  BulkReplace,
  CollectionDeclaration,
  DataCount,
  DataEnvelope,
  DataQuery,
  ExportCursor,
  OwnerDataCommand,
} from "@portifact/contracts/artifact-data";
import type { Caller } from "./documents.ts";
import { mutationActorName } from "./mutation.ts";

type Context = { now: number; limits: ArtifactDataLimits };

/**
 * The documents object's commands an owner-side command reaches. Each answers the object's
 * `Answer` of its own value type, which RPC carries as it is.
 */
export interface OwnerCommandTarget {
  describe(envelope: DataEnvelope, caller: Caller, context: Context): unknown;
  declare(
    envelope: DataEnvelope,
    caller: Caller,
    declaration: CollectionDeclaration,
    context: Context,
  ): unknown;
  indexStep(envelope: DataEnvelope, caller: Caller, context: Context): unknown;
  create(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    body: unknown,
    context: Context,
  ): unknown;
  get(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    id: string,
    context: Context,
  ): unknown;
  replace(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    id: string,
    body: unknown,
    context: Context,
  ): unknown;
  remove(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    id: string,
    context: Context,
  ): unknown;
  bulkCreate(envelope: DataEnvelope, caller: Caller, input: BulkCreate, context: Context): unknown;
  bulkReplace(
    envelope: DataEnvelope,
    caller: Caller,
    input: BulkReplace,
    context: Context,
  ): unknown;
  bulkRemove(
    envelope: DataEnvelope,
    caller: Caller,
    collection: string,
    ids: string[],
    context: Context,
  ): unknown;
  query(envelope: DataEnvelope, caller: Caller, query: DataQuery, context: Context): unknown;
  count(envelope: DataEnvelope, caller: Caller, count: DataCount, context: Context): unknown;
  exportPage(
    envelope: DataEnvelope,
    caller: Caller,
    after: ExportCursor | null,
    take: number,
    context: Context,
  ): unknown;
  prepareErase(envelope: DataEnvelope, eraseId: string, now: number): unknown;
  /** `audit`: the owner side's actor name; an owner's reset leaves its audit obligation. */
  commitErase(envelope: DataEnvelope, eraseId: string, now: number, audit?: string): unknown;
  cancelErase(envelope: DataEnvelope, eraseId: string, now: number): unknown;
}

/** The most documents one owner export page returns (the export cap). */
export const OWNER_EXPORT_TAKE = 500;

/** Runs one parsed owner-side command on a documents object, as the owner side's caller. */
export function runOwnerCommand(
  target: OwnerCommandTarget,
  envelope: DataEnvelope,
  actor: string,
  command: OwnerDataCommand,
  context: Context,
): unknown {
  const caller: Caller = { kind: "owner", actor };
  switch (command.kind) {
    case "describe":
      return target.describe(envelope, caller, context);
    case "declare":
      return target.declare(envelope, caller, command.declaration, context);
    case "index_step":
      return target.indexStep(envelope, caller, context);
    case "create":
      return target.create(envelope, caller, command.collection, command.body, context);
    case "get":
      return target.get(envelope, caller, command.collection, command.id, context);
    case "replace":
      return target.replace(
        envelope,
        caller,
        command.collection,
        command.id,
        command.body,
        context,
      );
    case "remove":
      return target.remove(envelope, caller, command.collection, command.id, context);
    case "bulk_create":
      return target.bulkCreate(envelope, caller, command.input, context);
    case "bulk_replace":
      return target.bulkReplace(envelope, caller, command.input, context);
    case "bulk_remove":
      return target.bulkRemove(envelope, caller, command.collection, command.ids, context);
    case "query":
      return target.query(envelope, caller, command.query, context);
    case "count":
      return target.count(envelope, caller, command.count, context);
    case "export":
      return target.exportPage(envelope, caller, command.after, OWNER_EXPORT_TAKE, context);
    // The owner's reset is an optional erase intent: never `requiredErase`, which only the
    // lifecycle sets, so it counts against the day's intents and refuses while held.
    case "erase": {
      const { opId: _op, requiredErase: _required, ...plain } = envelope;
      if (command.step === "prepare")
        return target.prepareErase(plain, command.eraseId, context.now);
      if (command.step === "commit") {
        return target.commitErase(plain, command.eraseId, context.now, mutationActorName(caller));
      }
      return target.cancelErase(plain, command.eraseId, context.now);
    }
  }
}
