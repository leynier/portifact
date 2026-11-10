-- A reduced regional database: the artifact row and the index tables the product would add.
CREATE TABLE artifacts (
  id text PRIMARY KEY NOT NULL,
  owner_id text NOT NULL,
  state text NOT NULL,
  current_version_id text,
  lifecycle_generation integer DEFAULT 0 NOT NULL
);

CREATE TABLE outbox (
  id text PRIMARY KEY NOT NULL,
  topic text NOT NULL,
  payload text NOT NULL
);

-- One row per indexed artifact: which version the index holds. Regular table, known to Drizzle.
CREATE TABLE search_artifacts (
  artifact_id text PRIMARY KEY NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  version_id text NOT NULL,
  text_bytes integer NOT NULL,
  partial integer NOT NULL
);
CREATE INDEX search_artifacts_owner ON search_artifacts (owner_id);

-- One row per indexed file. Its integer key is the rowid of the full-text row.
CREATE TABLE search_files (
  id integer PRIMARY KEY AUTOINCREMENT,
  artifact_id text NOT NULL REFERENCES search_artifacts(artifact_id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  path text NOT NULL
);
CREATE INDEX search_files_artifact ON search_files (artifact_id);

-- The full-text table: the owner as one token (a column filter, so a search never leaves the
-- owner) and the body. Drizzle never sees it; only raw SQL in a custom migration creates it.
CREATE VIRTUAL TABLE search_text USING fts5(owner, body, tokenize = 'unicode61 remove_diacritics 2');

-- Removing a file row removes its text, so every way a file row goes (a cascade from the
-- artifact, a reindex) also empties the full-text table.
CREATE TRIGGER search_files_delete AFTER DELETE ON search_files BEGIN
  DELETE FROM search_text WHERE rowid = old.id;
END;

-- An artifact that stops being active stops being searchable, whatever path changed its state.
CREATE TRIGGER artifacts_unindex_inactive AFTER UPDATE OF state ON artifacts
WHEN new.state <> 'active' BEGIN
  DELETE FROM search_artifacts WHERE artifact_id = new.id;
END;

CREATE TRIGGER artifacts_unindex_moved AFTER UPDATE OF owner_id ON artifacts
WHEN new.owner_id <> old.owner_id BEGIN
  DELETE FROM search_artifacts WHERE artifact_id = new.id;
END;

-- The same text under the trigram tokenizer, only to compare matching and size.
CREATE VIRTUAL TABLE trigram_text USING fts5(body, tokenize = 'trigram remove_diacritics 1');
CREATE VIRTUAL TABLE unicode_text USING fts5(body, tokenize = 'unicode61 remove_diacritics 2');
