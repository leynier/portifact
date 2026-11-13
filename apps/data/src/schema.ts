// The documents object's tables (decision 0026, "One object"). Every statement the object runs is
// written by Portifact: there is no owner SQL, so no owner schema, trigger or reference exists that
// could block an erasure or make a statement's cost unbounded.
//
// Payload tables hold the artifact's data and are what a whole erase deletes; control tables hold
// what an erase keeps (barriers, day counters, rights rows, rate rows, audit obligations and ended
// erase intents) and the control record in `pf_meta`. Every retained control class is pruned
// through an index that leads with its age.
//
// The schema is created by the first durable write that binds the object (never by a read, so an
// empty object stays empty), and its version is the one metadata row a cold start reads
// (`SCHEMA_PROBE`): delivery 2 measured 24 rows read per wake for scanning `sqlite_schema`.

/** The current schema version, kept in `pf_meta` under `schema`. */
export const SCHEMA_VERSION = 1;

/** Tables a whole erase deletes, in no particular order: the payload. */
export const PAYLOAD_TABLES = [
  "pf_collections",
  "pf_fields",
  "pf_documents",
  "pf_values",
  "pf_value_counts",
  "pf_author_counts",
  "pf_seq",
  "pf_ops",
] as const;

/** Control tables, which every erase keeps. */
export const CONTROL_TABLES = [
  "pf_meta",
  "pf_audit",
  "pf_barriers",
  "pf_rates",
  "pf_days",
  "pf_rights",
  "pf_ended",
] as const;

/** The one row a cold start reads: one row read whatever the object holds. */
export const SCHEMA_PROBE = "SELECT value FROM pf_meta WHERE key = 'schema'";

/** Version 1, created in one transaction with the binding write. */
export const SCHEMA_V1 = [
  // The control record (`control`) and the schema version (`schema`).
  "CREATE TABLE pf_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
  // Payload.
  `CREATE TABLE pf_collections (
    name TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    unique_key TEXT,
    documents INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    position INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE pf_fields (
    collection TEXT NOT NULL,
    field TEXT NOT NULL,
    state TEXT NOT NULL,
    cursor TEXT,
    position INTEGER NOT NULL,
    PRIMARY KEY (collection, field)
  ) WITHOUT ROWID`,
  "CREATE INDEX pf_fields_state ON pf_fields (state, collection, field)",
  // `vals` holds the document's indexed values as JSON, so deleting or replacing it deletes its
  // `pf_values` rows by their primary key without another index.
  `CREATE TABLE pf_documents (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    author TEXT NOT NULL,
    editor TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    unique_value TEXT,
    body TEXT NOT NULL,
    size INTEGER NOT NULL,
    vals TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  ) WITHOUT ROWID`,
  "CREATE INDEX pf_documents_created ON pf_documents (collection, created, id)",
  "CREATE INDEX pf_documents_author ON pf_documents (collection, author, created, id)",
  // Author first: author erasure and a visitor's own export, in primary key order.
  "CREATE INDEX pf_documents_creator ON pf_documents (author, collection, id)",
  "CREATE INDEX pf_documents_editor ON pf_documents (editor, collection, id) WHERE editor IS NOT NULL",
  `CREATE INDEX pf_documents_unique ON pf_documents (collection, author, unique_value)
    WHERE unique_value IS NOT NULL`,
  `CREATE TABLE pf_values (
    collection TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    created INTEGER NOT NULL,
    id TEXT NOT NULL,
    PRIMARY KEY (collection, field, value, created, id)
  ) WITHOUT ROWID`,
  `CREATE TABLE pf_value_counts (
    collection TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (collection, field, value)
  ) WITHOUT ROWID`,
  `CREATE TABLE pf_author_counts (
    collection TEXT NOT NULL,
    author TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (collection, author)
  ) WITHOUT ROWID`,
  "CREATE INDEX pf_author_counts_author ON pf_author_counts (author)",
  "CREATE TABLE pf_seq (scope TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID",
  `CREATE TABLE pf_ops (
    key TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    result TEXT,
    at INTEGER NOT NULL
  ) WITHOUT ROWID`,
  "CREATE INDEX pf_ops_at ON pf_ops (at)",
  "CREATE INDEX pf_ops_actor ON pf_ops (actor)",
  // Control.
  `CREATE TABLE pf_audit (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    owner TEXT NOT NULL,
    state TEXT NOT NULL,
    at INTEGER NOT NULL
  ) WITHOUT ROWID`,
  "CREATE INDEX pf_audit_state ON pf_audit (state, at)",
  `CREATE TABLE pf_barriers (
    author TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    complete INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE pf_rates (
    subject TEXT NOT NULL,
    kind TEXT NOT NULL,
    window INTEGER NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (subject, kind, window)
  ) WITHOUT ROWID`,
  "CREATE INDEX pf_rates_window ON pf_rates (window)",
  `CREATE TABLE pf_days (
    day INTEGER PRIMARY KEY,
    growth INTEGER NOT NULL,
    read INTEGER NOT NULL,
    cleanup INTEGER NOT NULL,
    export INTEGER NOT NULL,
    rights INTEGER NOT NULL,
    protected INTEGER NOT NULL,
    live INTEGER NOT NULL,
    refused INTEGER NOT NULL,
    intents INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE pf_rights (
    author TEXT NOT NULL,
    day INTEGER NOT NULL,
    used INTEGER NOT NULL,
    PRIMARY KEY (author, day)
  ) WITHOUT ROWID`,
  "CREATE INDEX pf_rights_day ON pf_rights (day)",
  `CREATE TABLE pf_ended (
    id TEXT PRIMARY KEY,
    outcome TEXT NOT NULL,
    at INTEGER NOT NULL
  ) WITHOUT ROWID`,
  "CREATE INDEX pf_ended_at ON pf_ended (at)",
] as const;

/** Each version's statements, applied in order from the stored version (none yet past 1). */
export const MIGRATIONS: Record<number, readonly string[]> = {};
