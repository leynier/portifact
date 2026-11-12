// Owner SQL checks that run before SQLite sees a statement (decision 0026, "Owner SQL"). A lexer,
// not a parser: it only needs to know where strings, identifiers and comments end, so it can
// refuse a second statement and a few keywords. Everything about which tables a statement
// writes is decided by SQLite itself (`EXPLAIN`, in the object), never by reading the text.

/** The longest statement the owner side may send. Cloudflare's own limit is 100 KB. */
export const MAX_STATEMENT_BYTES = 16 * 1024;
/** Bound parameters per statement: Cloudflare's limit for Durable Object SQL. */
export const MAX_PARAMS = 100;

/**
 * Keywords refused anywhere outside strings and identifiers. `RECURSIVE` is the one way to write
 * a statement that never ends over a small database; `TRIGGER` would let a write to the owner's
 * own table write the reserved tables in a subprogram `EXPLAIN` does not show. Transactions,
 * `ATTACH`, `PRAGMA` and `VACUUM` are refused by workerd's own authorizer (measured in the spike);
 * they are listed here too so the caller gets a clear `invalid_input` instead of a platform error.
 * (`END` is not listed: `CASE ... END` needs it, and workerd refuses `END TRANSACTION` itself.)
 */
export const REFUSED_KEYWORDS = new Set([
  "RECURSIVE",
  "TRIGGER",
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "VACUUM",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);

export type GuardResult = { ok: true } | { ok: false; reason: string };

function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

/** Where a quoted run that opens at `start` with `close` ends (doubled quotes escape it). */
function skipQuoted(sql: string, start: number, close: string): number {
  let at = start + 1;
  while (at < sql.length) {
    if (sql[at] === close) {
      if (close !== "]" && sql[at + 1] === close) {
        at += 2;
        continue;
      }
      return at + 1;
    }
    at += 1;
  }
  return -1;
}

/** One statement, no refused keyword, within the size and parameter limits. */
export function checkStatement(sql: string, params: readonly unknown[]): GuardResult {
  if (new TextEncoder().encode(sql).length > MAX_STATEMENT_BYTES) {
    return { ok: false, reason: "statement too long" };
  }
  if (params.length > MAX_PARAMS) return { ok: false, reason: "too many parameters" };
  let at = 0;
  let ended = false;
  let sawStatement = false;
  while (at < sql.length) {
    const char = sql[at] as string;
    const next = sql[at + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", at);
      at = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", at + 2);
      if (end === -1) return { ok: false, reason: "unterminated comment" };
      at = end + 2;
      continue;
    }
    if (/\s/.test(char)) {
      at += 1;
      continue;
    }
    if (ended) return { ok: false, reason: "one statement per call" };
    if (char === ";") {
      ended = true;
      at += 1;
      continue;
    }
    sawStatement = true;
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const end = skipQuoted(sql, at, char === "[" ? "]" : char);
      if (end === -1) return { ok: false, reason: "unterminated quote" };
      at = end;
      continue;
    }
    if (isWordChar(char)) {
      let end = at;
      while (end < sql.length && isWordChar(sql[end] as string)) end += 1;
      const word = sql.slice(at, end).toUpperCase();
      if (REFUSED_KEYWORDS.has(word)) return { ok: false, reason: `${word} is not allowed` };
      at = end;
      continue;
    }
    at += 1;
  }
  return sawStatement ? { ok: true } : { ok: false, reason: "empty statement" };
}

/**
 * Opcodes of an `EXPLAIN` listing that write a b-tree, with the operand that names its root
 * page. A statement may not run any of them on a reserved table or index, and a read-only call
 * may not run any of them at all.
 */
export const WRITE_OPCODES: Readonly<Record<string, "p1" | "p2" | null>> = {
  OpenWrite: "p2",
  Clear: "p1",
  Destroy: "p1",
  CreateBtree: null,
  ParseSchema: null,
  DropTable: null,
  DropIndex: null,
  DropTrigger: null,
  VDestroy: null,
};

export interface ExplainRow {
  opcode: string;
  p1: number;
  p2: number;
}

/**
 * Decides from SQLite's own program whether a statement may run: a read may write nothing; a
 * write may not write a root page in `reserved` (the reserved tables and their indexes). Schema
 * changes (page 1) pass here and are checked after running, by comparing the reserved schema.
 */
export function checkProgram(
  program: readonly ExplainRow[],
  reserved: ReadonlySet<number>,
  write: boolean,
): GuardResult {
  for (const row of program) {
    if (!(row.opcode in WRITE_OPCODES)) continue;
    if (!write) return { ok: false, reason: "this call only reads" };
    const operand = WRITE_OPCODES[row.opcode];
    if (operand !== null && operand !== undefined && reserved.has(row[operand])) {
      return { ok: false, reason: "reserved tables are written only through the document API" };
    }
  }
  return { ok: true };
}
