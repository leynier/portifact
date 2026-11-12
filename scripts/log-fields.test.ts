// What the Workers log (decision 0005, "What leaves the EU"; "Secrets and logs" in docs/security.md).
// Workers observability is global, outside every region, so no log line of any owner may carry an
// artifact's name, a comment's text, an email address, a URL path or an error's free text. Every
// log line goes through `logEvent` (or `logSummary` for the two run summaries) in
// packages/domain/src/logs.ts, whose types refuse free text where they can. This guard scans the
// Workers' and the shared packages' shipped source and refuses:
// - any other use of `console`: a call, a bracket access, an alias, `trace`, `table`, `dir`,
//   `assert` and the rest (only packages/domain/src/logs.ts may name it);
// - `logEvent` or `logSummary` used other than as a direct call (an alias would escape the checks);
// - a `logEvent` whose event is not a string literal, whose fields are not an object literal, or
//   that holds a spread, a field outside `ALLOWED_FIELDS` or a value of the wrong kind;
// - a `logSummary` outside the call sites `SUMMARIES` lists.
// A new field or summary is added here deliberately, with what it holds.
//
// Not scanned: apps/web, packages/ui and packages/bridge run in the visitor's browser; the CLI and
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
/** The one file that may name `console`. */
const HELPER = "packages/domain/src/logs.ts";

const IDENT = "[A-Za-z_$][\\w$]*";
const PATH = `${IDENT}(?:\\.${IDENT})*`;
const LITERAL = `"[a-z0-9_]*"`;
const re = (source: string) => new RegExp(`^(?:${source})$`);

/** Each allowed field, what it holds and the shapes its value may take. */
export const ALLOWED_FIELDS: Record<string, { holds: string; value: RegExp }> = {
  reason: { holds: "an enum (literal union, checked by type)", value: re(`${LITERAL}|reason`) },
  outcome: {
    holds: "an enum: a job's or an email event's outcome",
    value: re(`${LITERAL}|outcome`),
  },
  type: {
    holds: "an enum: an email event's kind",
    value: re(`${LITERAL}|emailEventKind\\(${PATH}\\)`),
  },
  topic: { holds: "an outbox topic (an enum)", value: re(`${PATH}\\.topic`) },
  moment: {
    holds: "a grace email's moment (an enum: start, two_weeks, three_days)",
    value: re(`${LITERAL}|moment|${PATH}\\.moment`),
  },
  error: {
    holds: "errorLabel(...): a name and codes, never a message",
    value: re(`errorLabel\\(${IDENT}\\)`),
  },
  region: { holds: "a region name", value: re(`region|${PATH}\\.region`) },
  messageId: { holds: "a queue message's ID", value: re(`${PATH}\\.id`) },
  eventId: { holds: "Email Service's event ID", value: re(`${PATH}\\.eventId \\?\\? null`) },
  id: { holds: "an outbox row's ID", value: re(`${PATH}\\.id`) },
  workspaceId: {
    holds: "an opaque workspace ID",
    value: re(`workspaceId|${PATH}\\.(?:id|workspaceId)`),
  },
  ownerId: {
    holds: "an owner's opaque ID (an account or a workspace)",
    value: re(`ownerId|${PATH}\\.ownerId`),
  },
  connectionId: {
    holds: "an integration connection's opaque ID (`ic_`), or null when the path named none",
    value: re(`connectionId|${PATH}\\.id`),
  },
  artifacts: { holds: "a count", value: re(`artifacts|${PATH}\\.length|\\d+`) },
  threads: { holds: "a count", value: re(`threads|${PATH}\\.length|\\d+`) },
  recipients: { holds: "a count", value: re(`recipients|${PATH}\\.length|\\d+`) },
  alerts: { holds: "a count", value: re(`alerts|${PATH}\\.length|\\d+`) },
};

/** Where `logSummary` may be called, by file: each summary holds only counts and enum values. */
const SUMMARIES: Record<string, string> = {
  "apps/jobs/src/index.ts": "the scheduled run's counts per scan and region, and the budget run",
  "apps/jobs/src/budget.ts": "a BudgetRunResult: level, projected spend, actions, alert kinds",
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

/**
 * The source with comments removed and string and template contents blanked (their quotes and
 * length kept), so a word in a comment or a message is never taken for code, and code inside a
 * template's `${...}` is kept.
 */
export function codeOnly(text: string): string {
  let out = "";
  let i = 0;
  const templates: number[] = [];
  while (i < text.length) {
    const char = text[i] as string;
    const next = text[i + 1];
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      let end = i + 1;
      while (end < text.length && text[end] !== char && text[end] !== "\n") {
        end += text[end] === "\\" ? 2 : 1;
      }
      const body = text.slice(i + 1, end);
      // A literal of an event or a level stays readable; any other text is blanked.
      out +=
        char + (/^[a-z0-9_]*$/.test(body) ? body : " ".repeat(body.length)) + (text[end] ?? "");
      i = end + 1;
      continue;
    }
    if (char === "`" || (char === "}" && templates.length > 0 && templates.at(-1) === 0)) {
      if (char === "}") templates.pop();
      out += char;
      i += 1;
      while (i < text.length && text[i] !== "`") {
        if (text[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (text[i] === "$" && text[i + 1] === "{") {
          out += "${";
          i += 2;
          templates.push(0);
          break;
        }
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (text[i] === "`") {
        out += "`";
        i += 1;
      }
      continue;
    }
    if (templates.length > 0) {
      if (char === "{") templates[templates.length - 1] = (templates.at(-1) as number) + 1;
      if (char === "}") templates[templates.length - 1] = (templates.at(-1) as number) - 1;
    }
    out += char;
    i += 1;
  }
  return out;
}

/** The text between the bracket at `open` and the one that closes it. */
function enclosed(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i] as string;
    if ("({[".includes(char)) depth += 1;
    else if (")}]".includes(char)) {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/** The top-level parts of a list, split on commas outside brackets. */
function parts(body: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] as string;
    if ("({[".includes(char)) depth += 1;
    else if (")}]".includes(char)) depth -= 1;
    else if (char === "," && depth === 0) {
      found.push(body.slice(start, i));
      start = i + 1;
    }
  }
  found.push(body.slice(start));
  return found.map((part) => part.trim().replace(/\s+/g, " ")).filter((part) => part.length > 0);
}

/** Why one `logEvent` call's arguments are refused (from code with strings kept), or nothing. */
export function eventProblems(argumentsText: string): string[] {
  const [level, event, fields, ...rest] = parts(argumentsText);
  const problems: string[] = [];
  if (!/^"(?:log|warn|error)"$/.test(level ?? "")) problems.push("the level is not a literal");
  if (!/^"[a-z0-9_]+"$/.test(event ?? "")) problems.push("the event is not a string literal");
  if (rest.length > 0) problems.push("too many arguments");
  if (fields === undefined) return problems;
  const object = /^\{([\s\S]*)\}$/.exec(fields);
  if (!object) return [...problems, "the fields are not an object literal"];
  for (const entry of parts(object[1] as string)) {
    if (entry.startsWith("...")) {
      problems.push(`spread ${entry.slice(3)} is not allowed`);
      continue;
    }
    const colon = entry.indexOf(":");
    const key = (colon === -1 ? entry : entry.slice(0, colon)).trim();
    const value = colon === -1 ? key : entry.slice(colon + 1).trim();
    const rule = ALLOWED_FIELDS[key];
    if (!rule) {
      problems.push(`field ${key} is not allowed`);
      continue;
    }
    if (!rule.value.test(value)) problems.push(`${key} is not ${rule.holds}: ${value}`);
  }
  return problems;
}

/** Every problem of one file, by line; `name` is its path from the repository root. */
export function fileProblems(name: string, text: string): string[] {
  const code = codeOnly(text);
  const lineOf = (at: number) => code.slice(0, at).split("\n").length;
  const problems: string[] = [];
  if (name !== HELPER) {
    for (const match of code.matchAll(/\bconsole\b/g)) {
      problems.push(`${name}:${lineOf(match.index ?? 0)}: console outside ${HELPER}`);
    }
  }
  for (const match of code.matchAll(/\b(logEvent|logSummary)\b/g)) {
    const at = match.index ?? 0;
    const before = code.slice(Math.max(0, at - 30), at);
    const after = code.slice(at + (match[1] as string).length);
    // Its definition, an import or an export list name it without calling it.
    if (
      /\bfunction\s*$/.test(before) ||
      /^\s*[,}]/.test(after) ||
      /\bimport\s*\{[^}]*$/.test(code.slice(0, at).slice(-300))
    ) {
      continue;
    }
    if (!/^\s*(?:<[^>]*>)?\(/.test(after)) {
      problems.push(`${name}:${lineOf(at)}: ${match[1]} used but not called`);
      continue;
    }
    if (match[1] === "logSummary") {
      if (!(name in SUMMARIES) && name !== HELPER) {
        problems.push(`${name}:${lineOf(at)}: logSummary outside the listed run summaries`);
      }
      continue;
    }
    if (name === HELPER) continue;
    const open = at + (match[1] as string).length + (after.indexOf("(") ?? 0);
    for (const problem of eventProblems(enclosed(code, open))) {
      problems.push(`${name}:${lineOf(at)}: ${problem}`);
    }
  }
  return problems;
}

describe("log lines of the Workers", () => {
  it("all go through logEvent with allowed fields and values", () => {
    const refused: string[] = [];
    let events = 0;
    for (const dir of SOURCES) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const name = relative(ROOT, file);
        const text = readFileSync(file, "utf8");
        events += (codeOnly(text).match(/\blogEvent\s*\(/g) ?? []).length;
        refused.push(...fileProblems(name, text));
      }
    }
    expect(refused).toEqual([]);
    // The log lines known today; a scan that finds none has lost its sources.
    expect(events).toBeGreaterThanOrEqual(35);
  });

  it.each([
    [
      "a field's value that is free text",
      'logEvent("error", "x", { reason: artifact.name, workspaceId: email });',
      ["reason is not", "workspaceId is not"],
    ],
    ["console by bracket", 'console["error"](error);', ["console outside"]],
    ["an aliased console", "const log = console.warn;\nlog(error.message);", ["console outside"]],
    ["console.trace", "console.trace(error.message);", ["console outside"]],
    [
      "console.table, dir, assert, debug and info",
      "console.table(a); console.dir(a); console.assert(a); console.debug(a); console.info(a);",
      ["console outside"],
    ],
    ["a new unlisted field", 'logEvent("log", "x", { email });', ["field email is not allowed"]],
    ["a spread", 'logEvent("log", "x", { ...row });', ["spread row is not allowed"]],
    [
      "an error that is not a label",
      'logEvent("log", "x", { error: String(error) });',
      ["error is not"],
    ],
    [
      "an event that is not a literal",
      'logEvent("log", kind);',
      ["the event is not a string literal"],
    ],
    [
      "fields that are not an object literal",
      'logEvent("log", "x", fields);',
      ["the fields are not an object literal"],
    ],
    [
      "an aliased logEvent",
      'const say = logEvent;\nsay("log", "x", { email });',
      ["used but not called"],
    ],
    ["logSummary at an unlisted site", 'logSummary("log", "x", row);', ["logSummary outside"]],
  ])("refuses %s", (_case, source, expected) => {
    const found = fileProblems("apps/app/src/example.ts", source);
    for (const fragment of expected) {
      expect(
        found.some((problem) => problem.includes(fragment)),
        `${fragment} in ${found}`,
      ).toBe(true);
    }
  });

  it("allows the shapes the helper's callers use, and console in comments and strings", () => {
    const source = [
      "// console.error(name) in a comment is not code",
      'const text = "console.log is just text";',
      'logEvent("error", "job_failed", { id: parsed.data.id, topic: parsed.data.topic, region: parsed.data.region, error: errorLabel(error) });',
      'logEvent("log", "expiry_notice_failed", { artifacts: artifacts.length });',
      'logEvent("log", "email_event", { type: emailEventKind(parsed.data.type), eventId: parsed.data.payload.eventId ?? null, outcome });',
      'logEvent("warn", "nothing");',
    ].join("\n");
    expect(fileProblems("apps/jobs/src/example.ts", source)).toEqual([]);
    expect(
      fileProblems("apps/jobs/src/index.ts", 'logSummary("log", "maintenance", result);'),
    ).toEqual([]);
  });
});
