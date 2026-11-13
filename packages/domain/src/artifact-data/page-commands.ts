// Which method of a documents object a page command runs (decision 0026, delivery 6): one
// dispatch, shared by the real object (`pageCommand` in apps/data) and the in-memory reference, so
// both answer the page through the same methods and the same caller rules. The caller carries
// `PAGE_MODES`, so a page reaches only `own` and `append` collections until delivery 9.
import type {
  ArtifactDataLimits,
  DataEnvelope,
  ExportCursor,
  PageCaller,
  PageDataCommand,
} from "@portifact/contracts/artifact-data";
import { type Caller, PAGE_MODES } from "./documents.ts";
import type { OwnerCommandTarget } from "./owner-commands.ts";

type Context = { now: number; limits: ArtifactDataLimits };

/** The documents object's commands a page command reaches. */
export interface PageCommandTarget
  extends Pick<OwnerCommandTarget, "get" | "query" | "create" | "replace" | "remove"> {
  exportMine(
    envelope: DataEnvelope,
    caller: Caller,
    after: ExportCursor | null,
    context: Context,
  ): unknown;
}

/** The page caller as the object's rules take it, limited to the modes a page reaches. */
export function pageCaller(caller: PageCaller): Caller {
  return caller.kind === "visitor"
    ? { kind: "visitor", author: caller.author, canWrite: caller.canWrite, modes: PAGE_MODES }
    : { kind: "reader", modes: PAGE_MODES };
}

/** Runs one parsed page command on a documents object. */
export function runPageCommand(
  target: PageCommandTarget,
  envelope: DataEnvelope,
  page: PageCaller,
  command: PageDataCommand,
  context: Context,
): unknown {
  const caller = pageCaller(page);
  switch (command.kind) {
    case "get":
      return target.get(envelope, caller, command.collection, command.id, context);
    case "query":
      return target.query(envelope, caller, command.query, context);
    case "create":
      return target.create(envelope, caller, command.collection, command.body, context);
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
    case "export_mine":
      return target.exportMine(envelope, caller, command.after, context);
  }
}
