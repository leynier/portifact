// What the Workers log (decision 0005, "What leaves the region"; "Logging" in docs/security.md).
// Workers observability is global, outside every region, so no log line of any owner may carry an
// artifact's name, a comment's text, an email address, a URL path or an error's free text. This
// scans the Workers' and the shared packages' source for every `console.*` call and fails for one
// that is not a plain message or `JSON.stringify` of an object whose fields are all in
// `ALLOWED_FIELDS`, with `error` only as `errorLabel(...)` (packages/domain/src/logs.ts) and a
// spread only where `SPREADS` lists it. A new field is added here deliberately, with what it holds.
//
// Not scanned: apps/web, packages/ui and packages/bridge run in the visitor's browser, the CLI and
// the operator tool (apps/jobs/scripts) print to the terminal of the person running them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SOURCES = [
  "apps/app/src",
  "apps/content/src",
  "apps/jobs/src",
  "packages/anchors/src",
  "packages/contracts/src",
  "packages/db/src",
  "packages/domain/src",
  "packages/emails/src",
  "packages/render/src",
  "packages/services/src",
];
const SKIP = new Set(["node_modules", "dist", "testing", "browser"]);

/** Field names a log line may carry, each an ID, a count, an enum, a region or an error label. */
export const ALLOWED_FIELDS: Record<string, string> = {
  event: "the event's name, a string literal",
  reason: "an enum of why a job skipped",
  error: "errorLabel(...): the error's name and leading code",
  region: "a region name",
  outcome: "a job outcome or an email event's outcome",
  type: "an email event's type (bounce, complaint)",
  messageId: "a queue message's ID",
  eventId: "Email Service's event ID",
  workspaceId: "an opaque workspace ID",
  artifacts: "a count of artifacts",
  threads: "a count of threads",
  recipients: "a count of recipients",
  alerts: "a count of budget alerts",
};

/** Spreads a log line may hold, by file: each object holds only allowed kinds of values. */
const SPREADS: Record<string, Record<string, string>> = {
  "apps/jobs/src/index.ts": {
    result: "the scheduled run's counts per scan and region, and the budget run's figures",
    "parsed.data": "a JobMessage: the outbox row's ID, its topic and its region",
  },
  "apps/jobs/src/budget.ts": {
    result: "a BudgetRunResult: level, projected spend, actions, analytics status, alert kinds",
  },
};

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

/** The text between the bracket at `open` and the one that closes it, skipping string literals. */
function enclosed(text: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i] as string;
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if ("({[".includes(char)) depth += 1;
    else if (")}]".includes(char)) {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/** The top-level entries of an object literal's body. */
function entries(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] as string;
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if ("({[".includes(char)) depth += 1;
    else if (")}]".includes(char)) depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

const PLAIN = /^(?:"[^"\\]*"|'[^'\\]*'|`[^`$\\]*`)$/;

/** Why one `console.*` call's argument is refused, or nothing when it is allowed. */
export function logProblems(argument: string, spreads: Record<string, string> = {}): string[] {
  const text = argument.trim().replace(/,$/, "").trim();
  if (PLAIN.test(text)) return [];
  const json = /^JSON\.stringify\(\s*\{([\s\S]*)\}\s*\)$/.exec(text);
  if (!json) return ["not a plain message or JSON.stringify of an object"];
  const problems: string[] = [];
  for (const entry of entries(json[1] as string)) {
    if (entry.startsWith("...")) {
      const spread = entry.slice(3).trim();
      if (!(spread in spreads)) problems.push(`spread ${spread} is not listed`);
      continue;
    }
    const colon = entry.indexOf(":");
    const key = (colon === -1 ? entry : entry.slice(0, colon)).trim();
    const value = colon === -1 ? key : entry.slice(colon + 1).trim();
    if (!(key in ALLOWED_FIELDS)) {
      problems.push(`field ${key} is not allowed`);
      continue;
    }
    if (key === "error" && !/^errorLabel\(\w+\)$/.test(value)) {
      problems.push("error is not errorLabel(...)");
    }
    if (key === "event" && !PLAIN.test(value)) problems.push("event is not a literal");
  }
  return problems;
}

/** Every `console.*` call in `text`, with its line and argument. */
export function consoleCalls(text: string): { line: number; argument: string }[] {
  const calls: { line: number; argument: string }[] = [];
  for (const match of text.matchAll(/\bconsole\.(?:log|error|warn|info|debug)\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    calls.push({
      line: text.slice(0, open).split("\n").length,
      argument: enclosed(text, open),
    });
  }
  return calls;
}

describe("log lines of the Workers", () => {
  it("carry only allowed fields, an error's label and listed spreads", () => {
    const refused: string[] = [];
    let count = 0;
    for (const dir of SOURCES) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const name = relative(ROOT, file);
        for (const call of consoleCalls(readFileSync(file, "utf8"))) {
          count += 1;
          for (const problem of logProblems(call.argument, SPREADS[name])) {
            refused.push(`${name}:${call.line}: ${problem}`);
          }
        }
      }
    }
    expect(refused).toEqual([]);
    // The log lines known today; a scan that finds none has lost its sources.
    expect(count).toBeGreaterThanOrEqual(35);
  });

  it("refuses names, addresses, free-text errors and unlisted spreads", () => {
    expect(logProblems('JSON.stringify({ event: "x", name: artifact.name })')).toEqual([
      "field name is not allowed",
    ]);
    expect(logProblems('JSON.stringify({ event: "x", email })')).toEqual([
      "field email is not allowed",
    ]);
    expect(logProblems('JSON.stringify({ event: "x", error: String(error) })')).toEqual([
      "error is not errorLabel(...)",
    ]);
    expect(logProblems('JSON.stringify({ event: "x", ...row })')).toEqual([
      "spread row is not listed",
    ]);
    expect(logProblems("`failed for ${url}`")).toEqual([
      "not a plain message or JSON.stringify of an object",
    ]);
    expect(logProblems("error")).toEqual(["not a plain message or JSON.stringify of an object"]);
    expect(logProblems("JSON.stringify({ event: kind })")).toEqual(["event is not a literal"]);
  });

  it("allows plain messages, allowed fields, labels and listed spreads", () => {
    expect(logProblems('"traffic metering write failed; kept for the next window"')).toEqual([]);
    expect(
      logProblems(
        'JSON.stringify({ event: "job_failed", ...parsed.data, error: errorLabel(error), region: handles.region }),',
        { "parsed.data": "a job message" },
      ),
    ).toEqual([]);
    expect(consoleCalls('a;\nconsole.error(JSON.stringify({ event: "x(" }));')).toEqual([
      { line: 2, argument: 'JSON.stringify({ event: "x(" })' },
    ]);
  });
});
