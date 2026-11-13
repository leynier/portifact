// The document model of decision 0026: collections with a mode, documents whose server fields the
// caller never sets, query shapes whose scan is bounded by an index seek, and the budgets every
// operation is charged against. Pure: no storage.

/** Who may read and write a collection's documents from the page (decision 0026, "Modes"). */
export const MODES = ["own", "append", "read", "shared"] as const;
export type Mode = (typeof MODES)[number];

/**
 * The caller as the Worker decided it, never as the page says. `visitor` is a person or an
 * anonymous visitor who granted this artifact an identity on the app origin (decision 0026,
 * "The grant"), with an opaque per-artifact `author` ID; `reader` can open the artifact but has
 * no grant (or only a share link); `owner` is the owner side (API, MCP, CLI), never the page.
 */
export type Caller =
  | { kind: "visitor"; author: string; canWrite: boolean }
  | { kind: "reader" }
  | { kind: "owner"; actor?: string };

export const OWNER_AUTHOR = "owner";

/** The plan's limits for one artifact, passed by the Worker on every call. */
export interface DataLimits {
  bytesPerArtifact: number;
  documentBytes: number;
  documentsPerCollection: number;
  collections: number;
  indexedFields: number;
  /** Writes (create and replace) per author per minute, attempts included. */
  writesPerAuthorPerMinute: number;
  /** Deletes per author per minute: a separate cleanup allowance. */
  deletesPerAuthorPerMinute: number;
  readsPerCallerPerMinute: number;
  /** Rows the artifact may read and write per UTC day, all callers and attempts together. */
  rowsReadPerDay: number;
  rowsWrittenPerDay: number;
  connectionsPerArtifact: number;
  connectionsPerAuthor: number;
  connectsPerAuthorPerMinute: number;
  /** Messages the live channel may send per UTC day, reserved in chunks of LIVE.reserveChunk. */
  liveMessagesPerDay: number;
  /** Rows deletes, shrinking replacements and erasures may touch per day: never the growth budget. */
  cleanupRowsPerDay: number;
  /** Rows exports may read per day: never the growth budget. */
  exportRowsPerDay: number;
  /**
   * Rows a visitor's deletion and export of their own documents may use per day, reserved for
   * them alone, so the owner's or other visitors' use of the shared pools never blocks them.
   */
  rightsRowsPerDay: number;
}

export type DataErrorCode =
  | "quarantined"
  | "not_found"
  | "forbidden"
  | "invalid_input"
  | "quota_exceeded"
  | "rate_limited"
  | "conflict"
  | "stale"
  | "held";

export class DataError extends Error {
  constructor(
    readonly code: DataErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const COLLECTION_NAME = /^[a-z][a-z0-9_]{0,31}$/;
export const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
export const MAX_DEPTH = 16;
export const MAX_PAGE = 100;

export function collectionName(name: unknown): string {
  if (typeof name !== "string" || !COLLECTION_NAME.test(name)) {
    throw new DataError("invalid_input", "collection names are 1 to 32 of a-z, 0-9 and _");
  }
  return name;
}

export function fieldName(name: unknown): string {
  if (typeof name !== "string" || !FIELD_NAME.test(name)) {
    throw new DataError("invalid_input", "field names are 1 to 32 letters, digits and _");
  }
  return name;
}

export function mode(value: unknown): Mode {
  if (typeof value !== "string" || !(MODES as readonly string[]).includes(value)) {
    throw new DataError("invalid_input", "mode must be own, append, read or shared");
  }
  return value as Mode;
}

function depthOf(value: unknown, depth: number): number {
  if (depth > MAX_DEPTH) return depth;
  if (value !== null && typeof value === "object") {
    let deepest = depth;
    for (const item of Object.values(value)) deepest = Math.max(deepest, depthOf(item, depth + 1));
    return deepest;
  }
  return depth;
}

export function documentBody(body: unknown, documentBytes: number): { text: string; size: number } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new DataError("invalid_input", "a document is a JSON object");
  }
  for (const key of Object.keys(body)) {
    if (key.startsWith("_")) {
      throw new DataError("invalid_input", "fields starting with _ are set by the server");
    }
  }
  if (depthOf(body, 0) > MAX_DEPTH)
    throw new DataError("invalid_input", "document nested too deep");
  const text = JSON.stringify(body);
  const size = new TextEncoder().encode(text).length;
  if (size > documentBytes) {
    throw new DataError("quota_exceeded", `a document holds at most ${documentBytes} bytes`);
  }
  return { text, size };
}

/**
 * The unique key's value: a string, a finite number or a boolean, stored as its JSON text, so
 * `1` and `"1"` differ and `1.0` equals `1`. Anything else is refused, so the key cannot be
 * dodged with an object or an array.
 */
export function uniqueValue(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  const scalar =
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
  if (!scalar) throw new DataError("invalid_input", `the unique field ${key} must be a scalar`);
  return JSON.stringify(value);
}

/**
 * A query, in the shapes whose scan an index seek bounds (decision 0026, "Queries"): at most one
 * equality (`_by` outside `own` mode, or a declared indexed field) and at most one range on
 * `_created`, ordered by `_created`. Everything else is refused, because an index that only
 * orders the result does not bound how many rows a sparse or empty match reads.
 */
export interface QuerySpec {
  collection: string;
  equals?: { field: string; value: string | number | boolean };
  created?: { op: "gt" | "gte" | "lt" | "lte"; value: number };
  order?: "created" | "-created";
  limit?: number;
  after?: string;
}

const RANGE = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

export function encodeCursor(created: number, id: string): string {
  return btoa(JSON.stringify([created, id])).replaceAll("=", "");
}

function decodeCursor(cursor: string): [number, string] {
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      Number.isSafeInteger(parsed[0]) &&
      typeof parsed[1] === "string"
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // Falls through to the refusal.
  }
  throw new DataError("invalid_input", "invalid cursor");
}

/**
 * The one SELECT a query runs, with its index named (`indexed by`), so SQLite seeks to the
 * matching range and walks it in order: rows read are at most the page plus one, whether the
 * match is dense, sparse or empty. In `own` mode the author is bound from the caller and is the
 * index prefix. An indexed field is queried through `pf_values`, which writes maintain and which
 * an index build fills in bounded steps; `ready` lists the fields whose build finished.
 */
export function buildQuery(
  spec: QuerySpec,
  scope: "all" | "own",
  author: string | null,
  ready: readonly string[],
): { sql: string; params: (string | number)[]; limit: number } {
  const params: (string | number)[] = [collectionName(spec.collection)];
  let from = "pf_documents d indexed by pf_documents_created";
  let key = "d";
  const conditions = ["d.collection = ?"];
  if (scope === "own") {
    if (spec.equals !== undefined) {
      throw new DataError("invalid_input", "own collections are filtered only by _created");
    }
    from = "pf_documents d indexed by pf_documents_author";
    conditions.push("d.author = ?");
    params.push(author as string);
  } else if (spec.equals !== undefined) {
    const { field, value } = spec.equals;
    if (field === "_by") {
      if (typeof value !== "string") throw new DataError("invalid_input", "_by is a string");
      from = "pf_documents d indexed by pf_documents_author";
      conditions.push("d.author = ?");
      params.push(value);
    } else if (ready.includes(field)) {
      from =
        "pf_values v indexed by pf_values_seek join pf_documents d on d.collection = v.collection and d.id = v.id";
      key = "v";
      conditions[0] = "v.collection = ?";
      conditions.push("v.field = ?", "v.value = ?");
      params.push(fieldName(field), typeof value === "boolean" ? (value ? 1 : 0) : value);
    } else {
      throw new DataError("invalid_input", "filter only on _by or a declared, built indexed field");
    }
  }
  if (spec.created !== undefined) {
    if (!(spec.created.op in RANGE) || !Number.isSafeInteger(spec.created.value)) {
      throw new DataError("invalid_input", "a _created range takes an operator and a time");
    }
    conditions.push(`${key}.created ${RANGE[spec.created.op]} ?`);
    params.push(spec.created.value);
  }
  const descending = spec.order === "-created";
  if (spec.after !== undefined) {
    const [created, id] = decodeCursor(spec.after);
    conditions.push(
      descending ? `(${key}.created, ${key}.id) < (?, ?)` : `(${key}.created, ${key}.id) > (?, ?)`,
    );
    params.push(created, id);
  }
  const limit = Math.min(Math.max(Math.trunc(spec.limit ?? 20), 1), MAX_PAGE);
  params.push(limit + 1);
  const direction = descending ? "desc" : "asc";
  const sql = `select d.id, d.author, d.created, d.updated, d.seq, d.editor, d.body from ${from} where ${conditions.join(" and ")} order by ${key}.created ${direction}, ${key}.id ${direction} limit ?`;
  return { sql, params, limit };
}

/**
 * A storage report's place in the object's history (finding 13): the generation, then a sequence
 * the object raises on every transaction that may change storage, refused work included.
 */
export interface SizeReport {
  generation: number;
  seq: number;
  bytes: number;
}

// The scopes and the report order are the production rules (decision 0026, delivery 3).
export { deleteScope, newerReport, readScope, writeScope } from "@portifact/domain/artifact-data";
