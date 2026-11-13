// The owner side's reads without SQL (decision 0026, "What the owner side can do without SQL"):
// counts from maintained counters (a collection, one author, or one built indexed value, each one
// row) and describe. Visitors get neither.
import type {
  CollectionInfo,
  CollectionMode,
  DataCount,
  DataDescription,
  DayCounters,
} from "@portifact/contracts/artifact-data";
import { accept, type Decision, refuse } from "./decision.ts";
import { type Caller, scalarText } from "./documents.ts";
import type { IndexField } from "./index-build.ts";

export type CountPlan =
  | { kind: "collection" }
  | { kind: "author"; author: string }
  | { kind: "value"; field: string; value: string };

/**
 * A count: the owner side only, one maintained row in every shape. An indexed value is counted
 * only once its field is built, like a query on it.
 */
export function planCount(
  count: DataCount,
  caller: Caller,
  ready: readonly string[],
): Decision<CountPlan> {
  if (caller.kind !== "owner") return refuse("forbidden", "owner side only");
  if (count.by !== undefined && count.equals !== undefined) {
    return refuse("invalid_input", "count by an author or by an indexed value, not both");
  }
  if (count.by !== undefined) return accept({ kind: "author", author: count.by });
  if (count.equals === undefined) return accept({ kind: "collection" });
  if (!ready.includes(count.equals.field)) {
    return refuse("invalid_input", "count only by a declared, built indexed field");
  }
  return accept({
    kind: "value",
    field: count.equals.field,
    value: scalarText(count.equals.value) as string,
  });
}

/** One collection as describe answers it, its fields in declaration order. */
export function describeCollection(
  name: string,
  facts: { mode: CollectionMode; uniqueKey: string | null; documents: number; bytes: number },
  fields: readonly IndexField[],
): CollectionInfo {
  return {
    name,
    mode: facts.mode,
    uniqueKey: facts.uniqueKey,
    indexed: fields
      .filter((field) => field.collection === name)
      .map((field) => ({ field: field.field, state: field.state })),
    documents: facts.documents,
    bytes: facts.bytes,
  };
}

/** Describe: the owner side only; collections sorted by name. */
export function describe(
  caller: Caller,
  input: {
    generation: number;
    revision: number;
    collections: readonly CollectionInfo[];
    today: DayCounters;
  },
): Decision<DataDescription> {
  if (caller.kind !== "owner") return refuse("forbidden", "owner side only");
  return accept({
    generation: input.generation,
    revision: input.revision,
    collections: [...input.collections].sort((a, b) => (a.name < b.name ? -1 : 1)),
    today: input.today,
  });
}
