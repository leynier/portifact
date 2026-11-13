// Bounded query planning (decision 0026, "The document model" and "What the owner side can do
// without SQL"). A query is accepted only in a shape whose scan an index seek bounds: every column
// of the index before `created` is bound by an equality, so the rows read are at most the page
// plus one (and the join's lookups), whether the match is dense, sparse or empty. Every other
// shape is refused, because an index that only orders the result does not bound how many rows a
// sparse or empty match reads.
//
// The shapes, each with its index:
//   created: (collection, created, id)                 no equality
//   author:  (collection, author, created, id)          `_by`, or the caller in an `own` scope
//   values:  (collection, field, value, created, id)    one built indexed field
// each with an optional range on `_created`, an order on `_created` and a cursor.
import { ARTIFACT_DATA, type DataQuery } from "@portifact/contracts/artifact-data";
import { accept, type Decision, refuse } from "./decision.ts";
import { type Caller, readScope, scalarText, utf8Length } from "./documents.ts";

export type QueryPlan =
  | { kind: "empty" }
  | {
      kind: "seek";
      index: "created" | "author" | "values";
      collection: string;
      /** The `author` index's bound author: the caller in an `own` scope, or `_by`. */
      author: string | null;
      /** The `values` index's field and canonical value. */
      field: string | null;
      value: string | null;
      range: { op: "gt" | "gte" | "lt" | "lte"; value: number } | null;
      descending: boolean;
      /** Rows to fetch: the page plus one, to know whether there is a next page. */
      fetch: number;
      limit: number;
      after: [number, string] | null;
    };

export function encodeCursor(created: number, id: string): string {
  return btoa(JSON.stringify([created, id])).replaceAll("=", "");
}

export function decodeCursor(cursor: string): [number, string] | null {
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      Number.isSafeInteger(parsed[0]) &&
      typeof parsed[1] === "string"
    ) {
      return [parsed[0] as number, parsed[1]];
    }
  } catch {
    // Falls through to null.
  }
  return null;
}

/**
 * Plans a query for a caller over a collection of the given mode, with `ready` the collection's
 * indexed fields whose build finished. A reader of an `own` collection gets an empty answer
 * without a read; a visitor in an `own` scope is bound to their own author and may not name
 * another (no equality at all, so no index outside their own author prefix is reachable).
 */
export function planQuery(
  query: DataQuery,
  mode: Parameters<typeof readScope>[0],
  caller: Caller,
  ready: readonly string[],
): Decision<QueryPlan> {
  const scope = readScope(mode, caller);
  if (scope === "none") return accept({ kind: "empty" });
  let after: [number, string] | null = null;
  if (query.after !== undefined) {
    after = decodeCursor(query.after);
    if (after === null) return refuse("invalid_input", "invalid cursor");
  }
  const limit = Math.min(
    Math.max(Math.trunc(query.limit ?? 20), 1),
    ARTIFACT_DATA.caps.pageDocuments,
  );
  const base = {
    kind: "seek" as const,
    collection: query.collection,
    range: query.created ?? null,
    descending: query.order === "-created",
    fetch: limit + 1,
    limit,
    after,
  };
  if (scope === "own") {
    if (query.equals !== undefined) {
      return refuse("invalid_input", "own collections are filtered only by _created");
    }
    const author = (caller as { author: string }).author;
    return accept({ ...base, index: "author", author, field: null, value: null });
  }
  if (query.equals === undefined) {
    return accept({ ...base, index: "created", author: null, field: null, value: null });
  }
  const { field, value } = query.equals;
  if (field === "_by") {
    if (typeof value !== "string") return refuse("invalid_input", "_by is a string");
    return accept({ ...base, index: "author", author: value, field: null, value: null });
  }
  if (!ready.includes(field)) {
    return refuse("invalid_input", "filter only on _by or a declared, built indexed field");
  }
  const text = scalarText(value) as string;
  if (utf8Length(text) > ARTIFACT_DATA.indexValueBytes) {
    return refuse("invalid_input", "values that long are not indexed");
  }
  return accept({ ...base, index: "values", author: null, field, value: text });
}

/**
 * Whether a document (by its creator, created time, ID and indexed values) is in a plan's range:
 * the reference meaning of a plan, which the object's statements must match and the property
 * tests check against.
 */
export function planMatches(
  plan: Extract<QueryPlan, { kind: "seek" }>,
  document: { author: string; created: number; id: string; values: Record<string, string> },
): boolean {
  if (plan.author !== null && document.author !== plan.author) return false;
  if (plan.field !== null && document.values[plan.field] !== plan.value) return false;
  if (plan.range !== null && !inRange(document.created, plan.range)) return false;
  if (plan.after === null) return true;
  const order = compareKeys([document.created, document.id], plan.after);
  return plan.descending ? order < 0 : order > 0;
}

function inRange(created: number, range: { op: string; value: number }): boolean {
  switch (range.op) {
    case "gt":
      return created > range.value;
    case "gte":
      return created >= range.value;
    case "lt":
      return created < range.value;
    default:
      return created <= range.value;
  }
}

/** Orders `(created, id)` keys as the indexes do. */
export function compareKeys(a: [number, string], b: [number, string]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] === b[1]) return 0;
  return a[1] < b[1] ? -1 : 1;
}

/** A page from the rows a plan fetched: at most `limit`, and a cursor when there were more. */
export function pageOf<T extends { created: number; id: string }>(
  rows: readonly T[],
  limit: number,
): { rows: T[]; next: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page,
    next: rows.length > limit && last !== undefined ? encodeCursor(last.created, last.id) : null,
  };
}
