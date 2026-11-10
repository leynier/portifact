/**
 * The smallest version of what the product would do: segment text so unicode61 finds words
 * inside Chinese and Japanese runs, build a MATCH expression only from plain terms, write an
 * artifact's rows in one guarded batch and search one owner's rows.
 */

/**
 * Separates CJK characters so unicode61 makes one token of each. One byte (a control character
 * unicode61 treats as a separator), stripped on read, so CJK text grows by a third, not threefold.
 */
export const SEGMENT = "\u001f";
export const MARK_OPEN = "\ue000";
export const MARK_CLOSE = "\ue001";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const TERM = /[\p{L}\p{N}\p{M}]+/gu;

/** The text as stored: markers and separators the index uses are removed first, CJK split. */
export function segment(text: string): string {
  // ё and е are one letter to a Russian reader; unicode61 keeps them apart, so fold here.
  const clean = text
    .replaceAll(SEGMENT, "")
    .replace(/[\ue000\ue001]/g, "")
    .replace(/ё/g, "е")
    .replace(/Ё/g, "Е");
  let out = "";
  let previousCjk = false;
  for (const char of clean) {
    const cjk = CJK.test(char);
    if (cjk && previousCjk) out += SEGMENT;
    out += char;
    previousCjk = cjk;
  }
  return out;
}

/** An owner ID as one unicode61 token, so `owner : <token>` matches exactly that owner. */
export function ownerToken(ownerId: string): string {
  let hex = "";
  for (const byte of new TextEncoder().encode(ownerId)) hex += byte.toString(16).padStart(2, "0");
  return `o${hex}`;
}

/** Plain terms only: every term becomes a quoted phrase, so no operator a user types survives. */
export function buildMatch(query: string, maxTerms = 8): string | null {
  const phrases: string[] = [];
  for (const [term] of query.slice(0, 200).matchAll(TERM)) {
    const chars = [...term];
    // A CJK run is a phrase of single characters, which finds it inside a longer run.
    const tokens = chars.some((c) => CJK.test(c))
      ? segment(term).split(SEGMENT).filter(Boolean)
      : [segment(term)];
    phrases.push(`"${tokens.join(" ")}"`);
    if (phrases.length === maxTerms) break;
  }
  return phrases.length === 0 ? null : phrases.join(" ");
}

export type IndexFile = { path: string; text: string };

/**
 * Replaces an artifact's rows with a version's, in one batch, only while that version is still
 * the artifact's current one and it is active: every write is conditioned on the same check.
 */
export async function indexArtifact(
  db: D1Database,
  input: { artifactId: string; ownerId: string; versionId: string; files: IndexFile[] },
): Promise<boolean> {
  const current =
    "exists (select 1 from artifacts where id = ?1 and current_version_id = ?2 and owner_id = ?3 and state = 'active')";
  const bytes = input.files.reduce((n, f) => n + new TextEncoder().encode(f.text).length, 0);
  const statements = [
    db
      .prepare(`delete from search_artifacts where artifact_id = ?1 and ${current}`)
      .bind(input.artifactId, input.versionId, input.ownerId),
    db
      .prepare(
        `insert into search_artifacts (artifact_id, owner_id, version_id, text_bytes, partial) select ?1, ?3, ?2, ?4, 0 where ${current}`,
      )
      .bind(input.artifactId, input.versionId, input.ownerId, bytes),
  ];
  for (const file of input.files) {
    statements.push(
      db
        .prepare(
          `insert into search_files (artifact_id, owner_id, path) select ?1, ?3, ?4 where ${current}`,
        )
        .bind(input.artifactId, input.versionId, input.ownerId, file.path),
      db
        .prepare(
          `insert into search_text (rowid, owner, body) select id, ?5, ?6 from search_files where artifact_id = ?1 and path = ?4 and ${current}`,
        )
        .bind(
          input.artifactId,
          input.versionId,
          input.ownerId,
          file.path,
          ownerToken(input.ownerId),
          segment(file.text),
        ),
    );
  }
  const results = await db.batch(statements);
  return (results[1]?.meta.changes ?? 0) === 1;
}

export type Hit = { artifactId: string; path: string; snippet: string; ranges: [number, number][] };

/** Turns FTS5's marked snippet into plain text and ranges; the separators are dropped. */
export function parseSnippet(marked: string): { snippet: string; ranges: [number, number][] } {
  let snippet = "";
  const ranges: [number, number][] = [];
  let start = -1;
  for (const char of marked) {
    if (char === SEGMENT) continue;
    if (char === MARK_OPEN) start = snippet.length;
    else if (char === MARK_CLOSE) {
      if (start >= 0 && snippet.length > start) {
        const last = ranges.at(-1);
        // Adjacent CJK characters are separate tokens: join their highlights.
        if (last && last[1] === start) last[1] = snippet.length;
        else ranges.push([start, snippet.length]);
      }
      start = -1;
    } else snippet += char;
  }
  return { snippet, ranges };
}

/** One owner's matches, one per artifact (its best file), newest artifact ID first. */
export async function searchOwner(
  db: D1Database,
  ownerId: string,
  query: string,
  limit = 20,
): Promise<{ hits: Hit[]; rowsRead: number }> {
  const match = buildMatch(query);
  if (!match) return { hits: [], rowsRead: 0 };
  const expression = `owner : ${ownerToken(ownerId)} AND (${match})`;
  const page = await db
    .prepare(
      `select f.artifact_id as artifactId, f.path as path, s.rowid as id, min(s.rank) as rank
       from search_text s join search_files f on f.id = s.rowid
       where search_text match ?1
       group by f.artifact_id order by f.artifact_id desc limit ?2`,
    )
    .bind(expression, limit)
    .all<{ artifactId: string; path: string; id: number }>();
  const ids = page.results.map((r) => r.id);
  if (ids.length === 0) return { hits: [], rowsRead: page.meta.rows_read };
  const snippets = await db
    .prepare(
      `select rowid as id, snippet(search_text, 1, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 16) as marked
       from search_text where search_text match ?1 and rowid in (select value from json_each(?2))`,
    )
    .bind(expression, JSON.stringify(ids))
    .all<{ id: number; marked: string }>();
  const byId = new Map(snippets.results.map((r) => [r.id, r.marked]));
  return {
    rowsRead: page.meta.rows_read + snippets.meta.rows_read,
    hits: page.results.map((r) => ({
      artifactId: r.artifactId,
      path: r.path,
      ...parseSnippet(byId.get(r.id) ?? ""),
    })),
  };
}
