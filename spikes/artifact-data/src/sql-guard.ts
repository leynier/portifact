// Owner SQL checks for the sandbox (decision 0026, "Owner SQL"). Fail closed: a statement runs
// only if its shape is on the allowlist below and every opcode of SQLite's own program for it is
// on the opcode allowlist; anything new, unknown or unclassified is refused. The sandbox holds no
// documents and no reserved SQL objects (its own state is in the object's key-value store, which
// SQL cannot reach), so these checks protect the platform's resources and the read-only promise,
// not the documents. Read-only execution is also enforced by running reads in a transaction that
// is always rolled back (`sandbox.ts`), whatever this file concludes.

export const MAX_STATEMENT_BYTES = 16 * 1024;
export const MAX_PARAMS = 100;
/** Bytes of all parameters together, measured before anything is parsed. */
export const MAX_PARAM_BYTES = 128 * 1024;

/**
 * Words refused anywhere outside strings and quoted identifiers. `WITH` covers every common
 * table expression, recursive or not, with or without `RECURSIVE` (finding 6): a later version may
 * allow non-recursive ones once a check can prove a CTE never names itself. `TRIGGER` and
 * `VIRTUAL` would add code or modules that run inside later statements; `TEMP` objects shadow
 * names for the connection; the rest is session and file control.
 */
export const REFUSED_WORDS = new Set([
  "WITH",
  "RECURSIVE",
  "TRIGGER",
  "VIRTUAL",
  "TEMP",
  "TEMPORARY",
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "VACUUM",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "REINDEX",
  "ANALYZE",
  "LOAD_EXTENSION",
]);

export type Shape = "read" | "write";

export type GuardResult = { ok: true; shape: Shape } | { ok: false; reason: string };

function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

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

/** The statement's bare words, in order, outside strings, quoted identifiers and comments. */
export function words(sql: string): { words: string[] } | { error: string } {
  const found: string[] = [];
  let at = 0;
  let ended = false;
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
      if (end === -1) return { error: "unterminated comment" };
      at = end + 2;
      continue;
    }
    if (/\s/.test(char)) {
      at += 1;
      continue;
    }
    if (ended) return { error: "one statement per call" };
    if (char === ";") {
      ended = true;
      at += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const end = skipQuoted(sql, at, char === "[" ? "]" : char);
      if (end === -1) return { error: "unterminated quote" };
      at = end;
      continue;
    }
    if (isWordChar(char)) {
      let end = at;
      while (end < sql.length && isWordChar(sql[end] as string)) end += 1;
      found.push(sql.slice(at, end).toUpperCase());
      at = end;
      continue;
    }
    at += 1;
  }
  return { words: found };
}

function paramBytes(params: readonly unknown[]): number {
  let total = 0;
  for (const param of params) {
    if (typeof param === "string") total += new TextEncoder().encode(param).length;
    else total += 16;
  }
  return total;
}

/**
 * The statement's shape, from its first words, against the allowlist: reads are `SELECT`;
 * writes are `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, `CREATE [UNIQUE] INDEX`,
 * `CREATE VIEW`, `DROP TABLE|INDEX|VIEW` and `ALTER TABLE`. Everything else is refused.
 */
export function classify(sql: string, params: readonly unknown[]): GuardResult {
  if (new TextEncoder().encode(sql).length > MAX_STATEMENT_BYTES) {
    return { ok: false, reason: "statement too long" };
  }
  if (params.length > MAX_PARAMS) return { ok: false, reason: "too many parameters" };
  if (paramBytes(params) > MAX_PARAM_BYTES) return { ok: false, reason: "parameters too large" };
  const lexed = words(sql);
  if ("error" in lexed) return { ok: false, reason: lexed.error };
  const list = lexed.words;
  if (list.length === 0) return { ok: false, reason: "empty statement" };
  for (const word of list) {
    if (REFUSED_WORDS.has(word)) return { ok: false, reason: `${word} is not allowed` };
  }
  const [first, second, third] = list;
  if (first === "SELECT") return { ok: true, shape: "read" };
  if (first === "INSERT" || first === "UPDATE" || first === "DELETE")
    return { ok: true, shape: "write" };
  if (first === "CREATE") {
    if (second === "TABLE" || second === "INDEX" || second === "VIEW")
      return { ok: true, shape: "write" };
    if (second === "UNIQUE" && third === "INDEX") return { ok: true, shape: "write" };
  }
  if (first === "DROP" && (second === "TABLE" || second === "INDEX" || second === "VIEW")) {
    return { ok: true, shape: "write" };
  }
  if (first === "ALTER" && second === "TABLE") return { ok: true, shape: "write" };
  return { ok: false, reason: "this kind of statement is not supported" };
}

/**
 * Opcodes a read may run (SQLite's VDBE, measured over the spike's corpus of supported reads).
 * Any other opcode refuses the statement: new SQLite features stay refused until reviewed. Row
 * operations (`Insert`, `Delete`) appear in reads on temporary cursors (sorting, window
 * functions); writing a stored table needs `OpenWrite` first, which only writes may run, and the
 * read call's rollback holds whatever this list says.
 */
export const READ_OPCODES = new Set([
  "Delete",
  "IdxDelete",
  "RowSetAdd",
  "RowSetRead",
  "RowSetTest",
  "IfEmpty",
  "Init",
  "Goto",
  "Halt",
  "Transaction",
  "TableLock",
  "OpenRead",
  "OpenEphemeral",
  "OpenPseudo",
  "OpenDup",
  "OpenAutoindex",
  "SorterOpen",
  "SorterInsert",
  "SorterSort",
  "SorterData",
  "SorterNext",
  "SorterCompare",
  "Rewind",
  "Next",
  "Prev",
  "SeekRowid",
  "SeekGE",
  "SeekGT",
  "SeekLE",
  "SeekLT",
  "SeekEnd",
  "SeekHit",
  "SeekScan",
  "NotFound",
  "Found",
  "NoConflict",
  "NotExists",
  "IdxGE",
  "IdxGT",
  "IdxLE",
  "IdxLT",
  "IdxRowid",
  "DeferredSeek",
  "Column",
  "Rowid",
  "NullRow",
  "Offset",
  "ResultRow",
  "MakeRecord",
  "IdxInsert",
  "Insert",
  "NewRowid",
  "Integer",
  "Int64",
  "Real",
  "String8",
  "String",
  "Null",
  "SoftNull",
  "Blob",
  "Variable",
  "Copy",
  "SCopy",
  "IntCopy",
  "Move",
  "Function",
  "PureFunc",
  "AggStep",
  "AggStep1",
  "AggFinal",
  "AggValue",
  "AggInverse",
  "Add",
  "Subtract",
  "Multiply",
  "Divide",
  "Remainder",
  "Concat",
  "BitAnd",
  "BitOr",
  "BitNot",
  "ShiftLeft",
  "ShiftRight",
  "AddImm",
  "MustBeInt",
  "RealAffinity",
  "Cast",
  "Affinity",
  "Eq",
  "Ne",
  "Lt",
  "Le",
  "Gt",
  "Ge",
  "ElseEq",
  "Compare",
  "Jump",
  "If",
  "IfNot",
  "IfPos",
  "IfNotZero",
  "IfNullRow",
  "IsNull",
  "NotNull",
  "IsTrue",
  "IsType",
  "ZeroOrNull",
  "Not",
  "And",
  "Or",
  "Once",
  "Gosub",
  "Return",
  "BeginSubrtn",
  "Yield",
  "InitCoroutine",
  "EndCoroutine",
  "DecrJumpZero",
  "OffsetLimit",
  "Sequence",
  "SequenceTest",
  "Count",
  "Filter",
  "FilterAdd",
  "CollSeq",
  "Permutation",
  "Noop",
  "Explain",
  "ReadCookie",
  "RowData",
  "MemMax",
  "ResetSorter",
  "Close",
  "ColumnsUsed",
  "TypeCheck",
  "HaltIfNull",
  "ReleaseReg",
  "CursorHint",
  "CursorLock",
  "CursorUnlock",
  "IfNoHope",
  "IFindKey",
  "RowCell",
  "IfSizeBetween",
  "Last",
]);

/** Opcodes a write may run on top of a read's. */
export const WRITE_OPCODES = new Set([
  "OpenWrite",
  "SetCookie",
  "Clear",
  "CreateBtree",
  "ParseSchema",
  "SqlExec",
  "Destroy",
  "DropTable",
  "DropIndex",
  "ResetCount",
  "FkCheck",
  "FkCounter",
  "FkIfZero",
  "Program",
  "Param",
  "VerifyCookie",
  "AutoCommit",
  "RenameTable",
  "AlterTable",
  "Expire",
  "MaxPgcnt",
  "Pagecount",
]);

/**
 * Opcodes refused even in writes because they run code or modules the platform does not
 * review: virtual tables (`VCreate`, `VUpdate`, `VOpen`, …, finding 1), triggers and nested
 * programs are refused by the lexer already; listing them here makes the refusal explicit.
 */
export const NEVER_OPCODES = new Set([
  "VBegin",
  "VCreate",
  "VDestroy",
  "VOpen",
  "VCheck",
  "VInitIn",
  "VFilter",
  "VColumn",
  "VNext",
  "VRename",
  "VUpdate",
  "LoadAnalysis",
  "Vacuum",
  "JournalMode",
  "IncrVacuum",
]);

export interface ExplainRow {
  opcode: string;
}

/** Fail closed over SQLite's own program: only allowlisted opcodes, writes only in write calls. */
export function checkProgram(program: readonly ExplainRow[], shape: Shape): GuardResult {
  for (const { opcode } of program) {
    if (NEVER_OPCODES.has(opcode)) return { ok: false, reason: `${opcode} is not allowed` };
    if (READ_OPCODES.has(opcode)) continue;
    if (shape === "write" && WRITE_OPCODES.has(opcode)) continue;
    return {
      ok: false,
      reason:
        shape === "read" && WRITE_OPCODES.has(opcode)
          ? "this call only reads"
          : `${opcode} is not supported`,
    };
  }
  return { ok: true, shape };
}
