// Every insert into `audit_events` records the database's clock in `recorded_at` (decision 0019,
// "Recorded time"): audit streams order and position themselves by it, and a row left at the
// column's constant default (0) would sort before every position and never be sent. This scans
// the shipped source for every statement that inserts into the table and fails for one that does
// not set the column with `recordedNow`, the one expression for it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SOURCES = ["packages", "apps"];
const SKIP = new Set(["node_modules", "dist", "test", "migrations", "access-migrations", "e2e"]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      found.push(path);
    }
  }
  return found;
}

/** The names a file gives `schema.auditEvents` (`const ae = schema.auditEvents`). */
function aliases(text: string): string[] {
  return [...text.matchAll(/const (\w+) = schema\.auditEvents\b/g)].map((m) => m[1] as string);
}

/**
 * Each insert into `audit_events` in `text`, as its statement's text (up to the end of the
 * template or call it builds), and whether it records `recordedNow`.
 */
export function auditInserts(text: string): { line: number; records: boolean }[] {
  const targets = ["schema\\.auditEvents", ...aliases(text)].join("|");
  const pattern = new RegExp(
    `\\.insert\\(\\s*(?:${targets})\\s*\\)|insert into [\`"]?audit_events\\b`,
    "g",
  );
  const found: { line: number; records: boolean }[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    // The statement: from the insert to the end of the select or values it builds.
    const rest = text.slice(start, start + 1_200);
    const end = rest.search(/\)\s*,\s*\n\s*(?:\/\/|[a-z]+\s*\n|\.\.\.|\w+\(|\]|\}|$)|\);\s*\n/);
    const statement = end === -1 ? rest : rest.slice(0, end + 1);
    found.push({
      line: text.slice(0, start).split("\n").length,
      records: /recordedNow/.test(statement),
    });
  }
  return found;
}

describe("inserts into audit_events", () => {
  it("all record the database's clock", () => {
    const missing: string[] = [];
    let count = 0;
    for (const dir of SOURCES) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const text = readFileSync(file, "utf8");
        for (const insert of auditInserts(text)) {
          count += 1;
          if (!insert.records) missing.push(`${relative(ROOT, file)}:${insert.line}`);
        }
      }
    }
    expect(missing).toEqual([]);
    // The writers known today (auditEvent, accountLeftEvents, the SCIM and policy statements).
    expect(count).toBeGreaterThanOrEqual(10);
  });

  it("flags an insert that leaves the column at its default", () => {
    const writer = [
      "const ae = schema.auditEvents;",
      "db.insert(ae).values({ id, ownerId, at, kind });",
      "db.insert(schema.auditEvents).select(sql`select ${id}, ${schema.recordedNow}`);",
      "await env.DB.prepare('insert into audit_events (id) values (?)');",
    ].join("\n");
    expect(auditInserts(writer)).toEqual([
      { line: 2, records: false },
      { line: 3, records: true },
      { line: 4, records: false },
    ]);
  });
});
