// The owner document API of artifact data in the fake server (decision 0026, delivery 5): enough
// of /api/v1/artifacts/:id/data for the CLI's `data` commands, with the API's bodies and errors.
// Documents live in memory per artifact; export pages hold `exportPage` documents so tests follow
// the cursor, and `moveRevisionDuringExport` makes the data change between pages.
import type {
  CollectionMode,
  DataCollectionView,
  DataDescriptionView,
  DataExportPageView,
} from "@portifact/contracts";

type Reply = { status: number; body?: unknown };
type ErrorOf = (code: "not_found" | "invalid_input" | "forbidden", message: string) => Reply;

interface FakeCollection {
  mode: CollectionMode;
  uniqueKey: string | null;
  indexed: string[];
  documents: Map<string, { body: string; created: number; updated: number; by: string }>;
}

export interface FakeData {
  collections: Map<string, Map<string, FakeCollection>>;
  revision: Map<string, number>;
  exportPage: number;
  moveRevisionDuringExport: boolean;
  /** Idempotency keys of the changes received, in order. */
  keys: (string | undefined)[];
}

export function createFakeData(): FakeData {
  return {
    collections: new Map(),
    revision: new Map(),
    exportPage: 2,
    moveRevisionDuringExport: false,
    keys: [],
  };
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `doc${String(counter).padStart(13, "0")}`;
}

/** Answers a data route of an existing artifact, or undefined when the path is not one. */
export function dataRoute(
  data: FakeData,
  input: {
    method: string;
    url: URL;
    raw: string;
    key: string | undefined;
    artifactExists: (id: string) => boolean;
    now: number;
    error: ErrorOf;
  },
): Reply | undefined {
  const path = input.url.pathname.slice("/api/v1".length);
  const match = /^\/artifacts\/([^/]+)\/data(\/.*)?$/.exec(path);
  if (!match) return undefined;
  const artifactId = decodeURIComponent(match[1] as string);
  const rest = match[2] ?? "";
  const { error, method } = input;
  if (!input.artifactExists(artifactId)) return error("not_found", "Artifact not found.");
  if (method !== "GET") data.keys.push(input.key);
  let collections = data.collections.get(artifactId);
  if (!collections) {
    collections = new Map();
    data.collections.set(artifactId, collections);
  }
  const bump = () => data.revision.set(artifactId, (data.revision.get(artifactId) ?? 0) + 1);
  const revision = () => data.revision.get(artifactId) ?? 0;
  const body = () => JSON.parse(input.raw || "null") as Record<string, unknown>;
  const view = (
    collection: string,
    id: string,
    doc: FakeCollection["documents"] extends Map<string, infer D> ? D : never,
  ) => ({
    ...(JSON.parse(doc.body) as object),
    _id: id,
    _by: doc.by,
    _editedBy: null,
    _created: doc.created,
    _updated: doc.updated,
    _seq: 1,
    __collection: collection,
  });
  const strip = (value: Record<string, unknown>) => {
    const { __collection, ...kept } = value;
    return kept;
  };
  const info = (name: string, c: FakeCollection) => ({
    name,
    mode: c.mode,
    uniqueKey: c.uniqueKey,
    indexed: c.indexed.map((field) => ({ field, state: "ready" as const })),
    documents: c.documents.size,
    bytes: [...c.documents.values()].reduce((sum, d) => sum + d.body.length, 0),
  });

  if (method === "GET" && rest === "") {
    const described: DataDescriptionView = {
      artifactId,
      exists: collections.size > 0,
      generation: 0,
      revision: revision(),
      collections: [...collections].map(([name, c]) => info(name, c)),
      today: {
        day: 0,
        growth: 3,
        read: 7,
        cleanup: 0,
        export: 0,
        rights: 0,
        protected: 0,
        live: 0,
        refused: 0,
        intents: 0,
      },
      limits: {
        bytesPerArtifact: 5_000_000,
        documentBytes: 16_384,
        documentsPerCollection: 1_000,
        collections: 10,
        indexedFields: 3,
        rowsReadPerDay: 500_000,
        rowsWrittenPerDay: 5_000,
        cleanupRowsPerDay: 5_000,
        exportRowsPerDay: 200_000,
      },
      storedBytes: 0,
    };
    return { status: 200, body: described };
  }
  if (method === "POST" && rest === "/collections") {
    const declared = body() as {
      name: string;
      mode: CollectionMode;
      uniqueKey?: string;
      indexed?: string[];
    };
    const existing = collections.get(declared.name);
    const collection: FakeCollection = existing ?? {
      mode: declared.mode,
      uniqueKey: declared.uniqueKey ?? null,
      indexed: [],
      documents: new Map(),
    };
    for (const field of declared.indexed ?? []) {
      if (!collection.indexed.includes(field)) collection.indexed.push(field);
    }
    collections.set(declared.name, collection);
    bump();
    const answer: DataCollectionView = { collection: info(declared.name, collection), building: 0 };
    return { status: 201, body: answer };
  }
  if (method === "POST" && rest === "/indexes/build") return { status: 200, body: { building: 0 } };
  if (method === "GET" && rest === "/count") {
    const name = input.url.searchParams.get("collection") ?? "";
    const collection = collections.get(name);
    if (!collection) return error("not_found", "No such collection.");
    const by = input.url.searchParams.get("by");
    const field = input.url.searchParams.get("equalsField");
    const value = input.url.searchParams.get("equalsValue");
    const documents = [...collection.documents.values()].filter((doc) => {
      if (by !== null) return doc.by === by;
      if (field !== null)
        return String((JSON.parse(doc.body) as Record<string, unknown>)[field]) === value;
      return true;
    }).length;
    return { status: 200, body: { documents } };
  }
  if (method === "GET" && rest === "/export") {
    const after = input.url.searchParams.get("after");
    const all = [...collections]
      .flatMap(([name, c]) => [...c.documents].map(([id, doc]) => ({ name, id, doc })))
      .sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1));
    const start =
      after === null ? 0 : all.findIndex((row) => `${row.name}/${row.id}` === after) + 1;
    const rows = all.slice(start, start + data.exportPage);
    const next =
      start + data.exportPage < all.length ? `${rows.at(-1)?.name}/${rows.at(-1)?.id}` : null;
    const page: DataExportPageView = {
      artifactId,
      revision: revision(),
      rows: rows.map(({ name, id, doc }) => ({
        collection: name,
        id,
        by: doc.by,
        editedBy: null,
        created: doc.created,
        updated: doc.updated,
        body: doc.body,
      })),
      next,
      header:
        after === null
          ? {
              generation: 0,
              revision: revision(),
              collections: [...collections].map(([name, c]) => ({
                name,
                mode: c.mode,
                uniqueKey: c.uniqueKey,
                indexed: c.indexed,
              })),
            }
          : null,
    };
    if (data.moveRevisionDuringExport) bump();
    return { status: 200, body: page };
  }

  const docs = /^\/collections\/([^/]+)\/documents(\/bulk|\/bulk-delete|\/([^/]+))?$/.exec(rest);
  if (!docs) return undefined;
  const name = decodeURIComponent(docs[1] as string);
  const collection = collections.get(name);
  if (!collection) return error("not_found", "No such collection.");
  const suffix = docs[2] ?? "";
  const docId = docs[3];
  const created = (value: unknown) => {
    const id = newId();
    collection.documents.set(id, {
      body: JSON.stringify(value),
      created: input.now,
      updated: input.now,
      by: "owner",
    });
    bump();
    return id;
  };
  if (method === "GET" && suffix === "") {
    const field = input.url.searchParams.get("equalsField");
    const value = input.url.searchParams.get("equalsValue");
    const documents = [...collection.documents]
      .filter(([, doc]) => {
        if (field === null) return true;
        if (field === "_by") return doc.by === value;
        return String((JSON.parse(doc.body) as Record<string, unknown>)[field]) === value;
      })
      .map(([id, doc]) => strip(view(name, id, doc)));
    return { status: 200, body: { documents, next: null } };
  }
  if (method === "POST" && suffix === "") {
    const id = created(body());
    const doc = collection.documents.get(id);
    return { status: 201, body: doc ? strip(view(name, id, doc)) : null };
  }
  if (method === "POST" && suffix === "/bulk") {
    const ids = (body().documents as unknown[]).map(created);
    return { status: 201, body: { ids } };
  }
  if (method === "PUT" && suffix === "/bulk") {
    const items = body().documents as { id: string; body: unknown }[];
    if (items.some((item) => !collection.documents.has(item.id))) {
      return error("not_found", "No such document.");
    }
    for (const item of items) {
      const doc = collection.documents.get(item.id);
      if (doc) Object.assign(doc, { body: JSON.stringify(item.body), updated: input.now });
    }
    bump();
    return { status: 200, body: { replaced: items.length } };
  }
  if (method === "POST" && suffix === "/bulk-delete") {
    const ids = body().ids as string[];
    if (ids.some((id) => !collection.documents.has(id))) {
      return error("not_found", "No such document.");
    }
    for (const id of ids) collection.documents.delete(id);
    bump();
    return { status: 200, body: { removed: ids.length } };
  }
  if (docId === undefined) return undefined;
  const doc = collection.documents.get(docId);
  if (!doc) return error("not_found", "No such document.");
  if (method === "GET") return { status: 200, body: strip(view(name, docId, doc)) };
  if (method === "PUT") {
    Object.assign(doc, { body: JSON.stringify(body()), updated: input.now });
    bump();
    return { status: 200, body: strip(view(name, docId, doc)) };
  }
  if (method === "DELETE") {
    collection.documents.delete(docId);
    bump();
    return { status: 200, body: { id: docId } };
  }
  return undefined;
}
