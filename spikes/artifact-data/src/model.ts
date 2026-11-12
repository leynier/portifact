// The document model of decision 0026: collections with a mode, documents whose server fields
// the caller never sets, and queries the server builds. Pure: no storage, so the rules can be
// read and tested without the object.

/** Who may read and write a collection's documents from the page (decision 0026, "Modes"). */
export const MODES = ["own", "append", "read", "shared"] as const;
export type Mode = (typeof MODES)[number];

/**
 * The caller as the Worker decided it, never as the page says. `visitor` is a person (an
 * account behind a read or review session, or an anonymous visitor cookie) with an opaque
 * per-artifact `author` ID; `reader` can open the artifact but names nobody (a share link
 * session, an anonymous visitor where writing is closed); `owner` is the owner side (API, MCP,
 * CLI), never the page.
 */
export type Caller =
  | { kind: "visitor"; author: string; canWrite: boolean }
  | { kind: "reader" }
  | { kind: "owner" };

/** The author recorded on documents the owner side creates. */
export const OWNER_AUTHOR = "owner";

/** The limits the object enforces, from the owner's plan; the Worker passes them on each call. */
export interface DataLimits {
  /** The object's whole database, documents and owner tables together. */
  bytesPerArtifact: number;
  /** One document's JSON body. */
  documentBytes: number;
  documentsPerCollection: number;
  collections: number;
  writesPerAuthorPerMinute: number;
  connectionsPerArtifact: number;
  connectionsPerAuthor: number;
}

export type DataErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_input"
  | "quota_exceeded"
  | "rate_limited"
  | "conflict";

export class DataError extends Error {
  constructor(
    readonly code: DataErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const COLLECTION_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/** Nesting a body may have: deep enough for app state, shallow enough for `json_extract`. */
export const MAX_DEPTH = 16;
/** Page size cap: every query reads at most this many documents past its filters. */
export const MAX_PAGE = 100;
/** Values one `in` filter may list. */
export const MAX_IN_VALUES = 20;

export function collectionName(name: unknown): string {
  if (typeof name !== "string" || !COLLECTION_NAME.test(name)) {
    throw new DataError("invalid_input", "collection names are 1 to 32 of a-z, 0-9 and _");
  }
  return name;
}

export function mode(value: unknown): Mode {
  if (typeof value !== "string" || !(MODES as readonly string[]).includes(value)) {
    throw new DataError("invalid_input", "mode must be own, append, read or shared");
  }
  return value as Mode;
}

/** Whether the caller reads every document of the collection (`all`), only its own, or none. */
export function readScope(mode: Mode, caller: Caller): "all" | "own" | "none" {
  if (caller.kind === "owner") return "all";
  if (mode !== "own") return "all";
  return caller.kind === "visitor" ? "own" : "none";
}

/** Whether the caller may create documents, and whose documents it may change. */
export function writeScope(mode: Mode, caller: Caller): "all" | "own" | "none" {
  if (caller.kind === "owner") return "all";
  if (caller.kind !== "visitor" || !caller.canWrite || mode === "read") return "none";
  return mode === "shared" ? "all" : "own";
}

function depthOf(value: unknown, depth: number): number {
  if (depth > MAX_DEPTH) return depth;
  if (Array.isArray(value)) {
    let deepest = depth;
    for (const item of value) deepest = Math.max(deepest, depthOf(item, depth + 1));
    return deepest;
  }
  if (value !== null && typeof value === "object") {
    let deepest = depth;
    for (const item of Object.values(value)) deepest = Math.max(deepest, depthOf(item, depth + 1));
    return deepest;
  }
  return depth;
}

/**
 * A document body: a plain JSON object whose top-level keys never start with `_` (the server's
 * fields), at most MAX_DEPTH deep and `documentBytes` long once serialized. Returns the text the
 * object stores and its size in UTF-8 bytes.
 */
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

/** One filter of a query. Only the server's fields and top-level body fields, never SQL. */
export interface Filter {
  field: string;
  op: "eq" | "lt" | "lte" | "gt" | "gte" | "in";
  value: string | number | boolean | null | (string | number)[];
}

export interface QuerySpec {
  collection: string;
  filters?: Filter[];
  order?: "created" | "-created";
  limit?: number;
  after?: string;
}

const OPS = { eq: "=", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;

function scalar(value: unknown): string | number | null {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new DataError("invalid_input", "filter values are strings, numbers, booleans or null");
}

/** The SQL expression a filter field reads: a server column or a top-level body field. */
function column(field: string): string {
  if (field === "_by") return "author";
  if (field === "_created") return "created";
  if (field === "_updated") return "updated";
  if (field === "_id") return "id";
  if (!FIELD_NAME.test(field)) throw new DataError("invalid_input", "unknown filter field");
  // The field name passed the pattern above, so it can be part of the JSON path literal.
  return `json_extract(body, '$.${field}')`;
}

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
 * The one SELECT a query runs. `author` is bound whenever the caller reads only its own
 * documents, after and independently of every filter, so no filter, cursor or ID can reach
 * another author's rows in `own` mode. Every query has a LIMIT of at most MAX_PAGE + 1 (one more
 * to know whether a next page exists), and the rows it can scan are bounded by the collection's
 * document cap.
 */
export function buildQuery(
  spec: QuerySpec,
  scope: "all" | "own",
  author: string | null,
): { sql: string; params: (string | number | null)[]; limit: number } {
  const conditions = ["collection = ?"];
  const params: (string | number | null)[] = [collectionName(spec.collection)];
  if (scope === "own") {
    conditions.push("author = ?");
    params.push(author);
  }
  const filters = spec.filters ?? [];
  if (filters.length > 4) throw new DataError("invalid_input", "at most 4 filters");
  for (const filter of filters) {
    const expression = column(filter.field);
    if (filter.op === "in") {
      if (!Array.isArray(filter.value) || filter.value.length === 0) {
        throw new DataError("invalid_input", "in takes a list");
      }
      if (filter.value.length > MAX_IN_VALUES) {
        throw new DataError("invalid_input", `in takes at most ${MAX_IN_VALUES} values`);
      }
      conditions.push(`${expression} in (${filter.value.map(() => "?").join(", ")})`);
      for (const value of filter.value) params.push(scalar(value));
    } else if (filter.op in OPS) {
      conditions.push(`${expression} ${OPS[filter.op]} ?`);
      params.push(scalar(filter.value));
    } else {
      throw new DataError("invalid_input", "unknown filter operator");
    }
  }
  const descending = spec.order === "-created";
  if (spec.after !== undefined) {
    const [created, id] = decodeCursor(spec.after);
    conditions.push(descending ? "(created, id) < (?, ?)" : "(created, id) > (?, ?)");
    params.push(created, id);
  }
  const limit = Math.min(Math.max(Math.trunc(spec.limit ?? 20), 1), MAX_PAGE);
  params.push(limit + 1);
  const direction = descending ? "desc" : "asc";
  const sql = `select id, author, created, updated, seq, body from pf_documents where ${conditions.join(" and ")} order by created ${direction}, id ${direction} limit ?`;
  return { sql, params, limit };
}
