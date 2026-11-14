// The document model's rules (decision 0026, "The document model"): who reads, writes and deletes
// in each collection mode, what a body may hold, the unique key, the server fields a write sets,
// which sequence a change advances and which indexed values a document has. Pure: the documents
// object reads the rows it needs and writes what these decide.
import {
  ARTIFACT_DATA,
  type ArtifactDataLimits,
  type ChargeClass,
  type CollectionDeclaration,
  type CollectionMode,
  MAX_INDEXED_FIELDS,
  OWNER_AUTHOR,
} from "@portifact/contracts/artifact-data";
import { accept, type Decision, refuse } from "./decision.ts";

/**
 * The caller as the Worker decided it, never as the page says. A visitor holds a grant with an
 * opaque per-artifact `author` ID; a reader can open the artifact without a grant (or through a
 * share link); the owner side is the API, MCP and CLI of the artifact's admins and editors.
 */
export type Caller =
  | { kind: "visitor"; author: string; canWrite: boolean; modes?: readonly CollectionMode[] }
  | { kind: "reader"; modes?: readonly CollectionMode[] }
  | { kind: "owner"; actor?: string };

/**
 * The collection modes a page reaches in delivery 6 (decision 0026, "Deliveries"): `read` and
 * `shared` from the page come with delivery 9, so a page caller carries these and every other
 * mode answers as if the caller had no access to it.
 */
export const PAGE_MODES: readonly CollectionMode[] = ["own", "append"];

/** Whether a page caller may reach a collection of this mode at all; the owner side always may. */
function modeReached(mode: CollectionMode, caller: Caller): boolean {
  return caller.kind === "owner" || caller.modes === undefined || caller.modes.includes(mode);
}

export type Scope = "all" | "own" | "none";

/** Who acts, as operation records and audit name them. */
export function actorOf(caller: Caller): string {
  if (caller.kind === "visitor") return caller.author;
  if (caller.kind === "owner") return `owner:${caller.actor ?? "owner"}`;
  return "reader";
}

/** The author a write by this caller records: the visitor's ID, or the owner side's. */
export function authorOf(caller: Caller): string | null {
  if (caller.kind === "visitor") return caller.author;
  return caller.kind === "owner" ? OWNER_AUTHOR : null;
}

export function readScope(mode: CollectionMode, caller: Caller): Scope {
  if (!modeReached(mode, caller)) return "none";
  if (caller.kind === "owner" || mode !== "own") return "all";
  return caller.kind === "visitor" ? "own" : "none";
}

export function writeScope(mode: CollectionMode, caller: Caller): Scope {
  if (!modeReached(mode, caller)) return "none";
  if (caller.kind === "owner") return "all";
  if (caller.kind !== "visitor" || !caller.canWrite || mode === "read") return "none";
  return mode === "shared" ? "all" : "own";
}

/**
 * Who may delete: the owner side always; a document's creator always, with or without write
 * permission or the current terms; in `shared` mode any writer.
 */
export function deleteScope(mode: CollectionMode, caller: Caller): Scope {
  if (!modeReached(mode, caller)) return "none";
  if (caller.kind === "owner") return "all";
  if (caller.kind !== "visitor") return "none";
  return mode === "shared" && caller.canWrite ? "all" : "own";
}

/** Whether a scope lets this caller reach a document by its creator. */
export function reaches(scope: Scope, caller: Caller, creator: string): boolean {
  if (scope === "all") return true;
  return scope === "own" && caller.kind === "visitor" && caller.author === creator;
}

function depthOf(value: unknown, depth: number): number {
  if (depth > ARTIFACT_DATA.maxDepth || value === null || typeof value !== "object") return depth;
  let deepest = depth;
  for (const item of Object.values(value)) deepest = Math.max(deepest, depthOf(item, depth + 1));
  return deepest;
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * A body: a JSON object without server fields (`_` prefix), nested at most `maxDepth`, at most the
 * plan's document size in UTF-8. Answers the text that is stored and its size.
 */
export function documentBody(
  body: unknown,
  documentBytes: number,
): Decision<{ text: string; size: number }> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return refuse("invalid_input", "a document is a JSON object");
  }
  if (Object.keys(body).some((key) => key.startsWith("_"))) {
    return refuse("invalid_input", "fields starting with _ are set by the server");
  }
  if (depthOf(body, 0) > ARTIFACT_DATA.maxDepth) {
    return refuse("invalid_input", "document nested too deep");
  }
  const text = JSON.stringify(body);
  const size = utf8Length(text);
  if (size > documentBytes) {
    return refuse("quota_exceeded", `a document holds at most ${documentBytes} bytes`);
  }
  return accept({ text, size });
}

/** A scalar's canonical text: `1` and `"1"` differ, `true` and `1` differ, `1.0` equals `1`. */
export function scalarText(value: unknown): string | null {
  const scalar =
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
  return scalar ? JSON.stringify(value) : null;
}

/**
 * The unique key's value, required and scalar, so it cannot be dodged with an object, an array or
 * a missing field. Unique per creator in the collection, on create and on replace.
 */
export function uniqueValue(body: Record<string, unknown>, key: string): Decision<string> {
  const text = scalarText(body[key]);
  if (text === null) return refuse("invalid_input", `the unique field ${key} must be a scalar`);
  return accept(text);
}

/**
 * The indexed values of a body: for each indexed field holding a scalar whose canonical text is at
 * most `indexValueBytes`, that text. Writes and index build steps both use it, so a document has
 * the same entries however they were made.
 */
export function indexEntries(
  body: Record<string, unknown>,
  fields: readonly string[],
): { field: string; value: string }[] {
  const entries: { field: string; value: string }[] = [];
  for (const field of fields) {
    const value = scalarText(body[field]);
    if (value !== null && utf8Length(value) <= ARTIFACT_DATA.indexValueBytes) {
      entries.push({ field, value });
    }
  }
  return entries;
}

/**
 * The sequence a change to a document advances: the creator's in `own` mode, so a visitor's
 * numbers reveal nothing about other authors, the collection's elsewhere.
 */
export function sequenceScope(mode: CollectionMode, collection: string, creator: string): string {
  return mode === "own" ? `author:${creator}` : `collection:${collection}`;
}

/** An erased author's sequence is never written again (`author:` scope of a barred author). */
export function sequenceAdvances(scope: string, barred: (author: string) => boolean): boolean {
  return !(scope.startsWith("author:") && barred(scope.slice("author:".length)));
}

/** `_editedBy` after a replacement: the editor when they are not the creator, else none. */
export function editorAfter(creator: string, editor: string): string | null {
  return editor === creator ? null : editor;
}

/** What the object knows about a declared collection. */
export interface CollectionFacts {
  mode: CollectionMode;
  uniqueKey: string | null;
  documents: number;
  bytes: number;
  /** Indexed fields of this collection, built or building. */
  fields: readonly string[];
}

/**
 * A declaration. A new collection needs room under the plan's count; an existing one keeps its
 * mode and unique key (changing either would let old sequence numbers or key values describe
 * documents the new rule hides), and can only gain indexed fields, up to the plan's count.
 */
export function declareCollection(
  existing: CollectionFacts | null,
  declaration: CollectionDeclaration,
  collections: number,
  limits: ArtifactDataLimits,
): Decision<{ create: boolean; addFields: string[] }> {
  const uniqueKey = declaration.uniqueKey ?? null;
  if (existing === null && collections >= limits.collections) {
    return refuse("quota_exceeded", `at most ${limits.collections} collections`);
  }
  if (
    existing !== null &&
    (existing.mode !== declaration.mode || existing.uniqueKey !== uniqueKey)
  ) {
    return refuse("conflict", "a collection's mode and unique key are fixed once declared");
  }
  const present = existing?.fields ?? [];
  const addFields = [...new Set(declaration.indexed ?? [])].filter(
    (field) => !present.includes(field),
  );
  const allowed = Math.min(limits.indexedFields, MAX_INDEXED_FIELDS);
  if (addFields.length > 0 && present.length + addFields.length > allowed) {
    return refuse("quota_exceeded", `at most ${allowed} indexed fields a collection`);
  }
  return accept({ create: existing === null, addFields });
}

/** A create needs room under the plan's documents per collection. */
export function createRefusal(collection: CollectionFacts, limits: ArtifactDataLimits) {
  if (collection.documents < limits.documentsPerCollection) return null;
  return refuse(
    "quota_exceeded",
    `a collection holds at most ${limits.documentsPerCollection} documents`,
  );
}

/**
 * Growth is refused when the documents' own bytes pass the plan's size, or when the database file
 * grew past it plus the reserve kept for control records. A change that grows neither always goes
 * through, so shrinking and deleting work on a full artifact.
 */
export function growthRefusal(
  sizes: { dataBytes: number; fileBefore: number; fileAfter: number; grew: number },
  limits: ArtifactDataLimits,
) {
  const dataFull = sizes.grew > 0 && sizes.dataBytes > limits.bytesPerArtifact;
  const fileFull =
    sizes.fileAfter > sizes.fileBefore &&
    sizes.fileAfter > limits.bytesPerArtifact + ARTIFACT_DATA.controlReserveBytes;
  return dataFull || fileFull ? refuse("quota_exceeded", "this artifact's data is full") : null;
}

/** A replacement that grows the document spends growth; one that does not spends cleanup. */
export function replaceClass(oldSize: number, newSize: number): ChargeClass {
  return newSize > oldSize ? "growth" : "cleanup";
}

/**
 * A visitor deleting a document they created spends the reserved rights allowance, so nobody
 * else's use can block it; every other delete spends cleanup.
 */
export function removeClass(caller: Caller, creator: string): ChargeClass {
  return caller.kind === "visitor" && caller.author === creator ? "rights" : "cleanup";
}

/** The server fields a document is answered with, over its stored body. */
export function presentDocument(row: {
  id: string;
  author: string;
  editor: string | null;
  created: number;
  updated: number;
  seq: number;
  body: string;
}): Record<string, unknown> {
  return {
    ...(JSON.parse(row.body) as Record<string, unknown>),
    _id: row.id,
    _by: row.author,
    _editedBy: row.editor,
    _created: row.created,
    _updated: row.updated,
    _seq: row.seq,
  };
}

/**
 * The changes to the maintained value counts when a document's indexed entries go from `before`
 * to `after` (a create has none before, a delete none after): one row per field and value, so a
 * count by indexed value reads one row.
 */
export function valueCountDeltas(
  before: readonly { field: string; value: string }[],
  after: readonly { field: string; value: string }[],
): { field: string; value: string; delta: number }[] {
  const deltas = new Map<string, { field: string; value: string; delta: number }>();
  const add = (entry: { field: string; value: string }, delta: number) => {
    const key = JSON.stringify([entry.field, entry.value]);
    const current = deltas.get(key) ?? { ...entry, delta: 0 };
    deltas.set(key, { ...current, delta: current.delta + delta });
  };
  for (const entry of before) add(entry, -1);
  for (const entry of after) add(entry, 1);
  return [...deltas.values()].filter((entry) => entry.delta !== 0);
}

/**
 * A value count after a change: the row is deleted (null) when nothing holds the value any more,
 * so no indexed value of a removed or erased document stays anywhere.
 */
export function nextValueCount(current: number, delta: number): number | null {
  const next = current + delta;
  return next > 0 ? next : null;
}

/** One body of a bulk write, validated. */
export interface BulkBody {
  text: string;
  size: number;
  unique: string | null;
}

/**
 * The bodies of an owner-side bulk create or replace, validated all or nothing: each is a valid
 * body, and with a unique key no two of them hold the same value (they share one creator, the
 * owner side, for a create; for a replace each keeps its creator, given in `creators`).
 */
export function bulkBodies(
  bodies: readonly unknown[],
  uniqueKey: string | null,
  creators: readonly string[],
  limits: ArtifactDataLimits,
): Decision<BulkBody[]> {
  if (bodies.length === 0 || bodies.length > ARTIFACT_DATA.caps.bulkDocuments) {
    return refuse("invalid_input", `between 1 and ${ARTIFACT_DATA.caps.bulkDocuments} documents`);
  }
  const seen = new Set<string>();
  const out: BulkBody[] = [];
  for (const [index, body] of bodies.entries()) {
    const parsed = documentBody(body, limits.documentBytes);
    if (!parsed.ok) return parsed;
    let unique: string | null = null;
    if (uniqueKey !== null) {
      const value = uniqueValue(body as Record<string, unknown>, uniqueKey);
      if (!value.ok) return value;
      const key = JSON.stringify([creators[index] ?? OWNER_AUTHOR, value.value]);
      if (seen.has(key)) return refuse("conflict", "two documents hold the same unique value");
      seen.add(key);
      unique = value.value;
    }
    out.push({ ...parsed.value, unique });
  }
  return accept(out);
}
