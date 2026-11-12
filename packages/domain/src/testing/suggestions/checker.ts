// The independent checker of decision 0027 ("What the spike proved", "The checker"). It is written
// apart from the planners and shares none of their code: it reads pages with happy-dom (the
// planners use parse5), compares IDs and references with a regular expression, compares the markup
// with every text run removed, checks the source bytes outside the approved range itself, and
// compares the text nodes at their DOM paths with the old raw text changed exactly at the
// reviewer's location, found through `packages/anchors`, which defines what a position means.
import { AnchorDocument, type AnchorElement } from "@portifact/anchors";
import type { FileKind } from "@portifact/contracts";
import type { Element, Node, Text } from "happy-dom";
import { pageOf, parseDocument, storedOf, type TextEdit } from "./pages.ts";

export interface Range {
  start: number;
  end: number;
  replacement: string;
}

/** Every value of every `id` and `href` attribute, in order: IDs and references. */
const ids = (html: string) =>
  [...html.matchAll(/ (id|href)="([^"]*)"/g)].map((match) => `${match[1]}=${match[2]}`);

/** The HTML with every text run removed; nothing else is dropped, comments included. */
const markup = (html: string) => html.replace(/>[^<]*</g, "><");

/** The bytes outside one approved range are the same, and the range holds the replacement. */
function sameOutside(old: string, next: string, range: Range): boolean {
  const after = range.start + range.replacement.length;
  return (
    next.length === old.length - (range.end - range.start) + range.replacement.length &&
    next.slice(0, range.start) === old.slice(0, range.start) &&
    next.slice(range.start, after) === range.replacement &&
    next.slice(after) === old.slice(range.end)
  );
}

/**
 * The approved range itself, constrained apart from the planner's claim: the two files' own
 * difference (common prefix and suffix removed) must be about as long as the range and its
 * replacement (an insertion or deletion inside repeated characters may slide, never grow), lie
 * within that distance of the range, and, in HTML, hold no markup on either side.
 */
function rangeHolds(kind: FileKind, old: string, next: string, range: Range): boolean {
  let prefix = 0;
  const shortest = Math.min(old.length, next.length);
  while (prefix < shortest && old[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldPart = old.slice(prefix, old.length - suffix);
  const newPart = next.slice(prefix, next.length - suffix);
  const width = range.end - range.start;
  const reach = Math.max(oldPart.length, newPart.length);
  return (
    width <= oldPart.length + 16 &&
    range.replacement.length <= newPart.length + 16 &&
    range.start - reach <= prefix &&
    old.length - suffix <= range.end + reach &&
    // In HTML text, `<` and `>` are always written as references; elsewhere they are text.
    (kind !== "html" || (!/[<>]/.test(oldPart) && !/[<>]/.test(newPart)))
  );
}

/** Text nodes of the whole document, head included, at their DOM paths, in document order. */
function witness(body: Node): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (node: Node, path: string) => {
    Array.from(node.childNodes).forEach((child, index) => {
      const here = `${path}/${child.nodeName.toLowerCase()}[${index}]`;
      if (child.nodeType === 3) found.set(here, (child as Text).data);
      else visit(child, here);
    });
  };
  visit(body, "html");
  return found;
}

/** The changed part of an edit, without the common prefix and suffix (written here again). */
function changed(edit: TextEdit): { prefix: string; deleted: string; inserted: string } {
  const before = Array.from(edit.before);
  const after = Array.from(edit.after);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return {
    prefix: before.slice(0, head).join(""),
    deleted: before.slice(head, before.length - tail).join(""),
    inserted: after.slice(head, after.length - tail).join(""),
  };
}

/** A run of text in a source file, decoded, with each decoded unit's raw span. */
interface Run {
  value: string;
  rawStart: number[];
  rawEnd: number[];
}

const decodedReferences = new Map<string, string>();

/** One character reference, decoded by happy-dom (the planners decode with parse5). */
function decodeReference(reference: string): string {
  let value = decodedReferences.get(reference);
  if (value === undefined) {
    value = parseDocument(`<!doctype html><body><p>${reference}</p>`).body.textContent ?? "";
    decodedReferences.set(reference, value);
  }
  return value;
}

/** Decodes a raw run of text, unit by unit: references whole, CRLF and lone CR as LF. */
function decodeRun(source: string, start: number, end: number, references: boolean): Run {
  const run: Run = { value: "", rawStart: [], rawEnd: [] };
  for (let at = start; at < end; ) {
    let raw = 1;
    let value = source[at] as string;
    const reference = references
      ? /^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.exec(source.slice(at, at + 40))
      : null;
    if (reference) {
      raw = reference[0].length;
      value = decodeReference(reference[0]);
    } else if (value === "\r") {
      raw = source[at + 1] === "\n" ? 2 : 1;
      value = "\n";
    }
    // One entry per UTF-16 unit, as node offsets count.
    for (let unit = 0; unit < value.length; unit++) {
      run.rawStart.push(at);
      run.rawEnd.push(at + raw);
    }
    run.value += value;
    at += raw;
  }
  return run;
}

/** Elements whose content is text up to their own end tag: markup inside it is not markup. */
const RAW_TEXT = new Set(["style", "script"]);
const ESCAPABLE_RAW_TEXT = new Set(["title", "textarea"]);

/**
 * The runs of text between an HTML file's tags and comments, in order. The content of `style`,
 * `script`, `title` and `textarea` is one run each, whatever it looks like, as it is one text
 * node in the page.
 */
function htmlRuns(source: string): Run[] {
  const runs: Run[] = [];
  let at = 0;
  while (at < source.length) {
    if (source.startsWith("<!--", at)) {
      const end = source.indexOf("-->", at + 4);
      at = end < 0 ? source.length : end + 3;
    } else if (source[at] === "<") {
      const name = /^<([a-z][a-z0-9]*)/i.exec(source.slice(at, at + 40))?.[1]?.toLowerCase();
      let quote: string | null = null;
      for (at++; at < source.length; at++) {
        const char = source[at];
        if (quote) {
          if (char === quote) quote = null;
        } else if (char === '"' || char === "'") quote = char;
        else if (char === ">") break;
      }
      at++;
      if (name !== undefined && (RAW_TEXT.has(name) || ESCAPABLE_RAW_TEXT.has(name))) {
        const close = source.toLowerCase().indexOf(`</${name}`, at);
        const end = close < 0 ? source.length : close;
        if (end > at) runs.push(decodeRun(source, at, end, ESCAPABLE_RAW_TEXT.has(name)));
        at = end;
      }
    } else {
      const end = source.indexOf("<", at) < 0 ? source.length : source.indexOf("<", at);
      runs.push(decodeRun(source, at, end, true));
      at = end;
    }
  }
  return runs;
}

/**
 * The source interval the selected text may change, derived here from the selected rendered
 * occurrence and the file's own decoding (never the planner's claim): the run whose decoded text
 * is the selected node's, the k-th such run for the k-th such node. Null when it cannot be read.
 */
function allowedInterval(
  kind: FileKind,
  source: string,
  data: string,
  sameBefore: number,
  from: number,
  length: number,
): { start: number; end: number } | null {
  if (kind === "text") {
    // happy-dom keeps the newline right after `<pre>` that browsers and parse5 drop.
    const run = decodeRun(source, 0, source.length, false);
    const shift = data === `\n${run.value}` ? 1 : 0;
    if (data.slice(shift) !== run.value) return null;
    return spanOf(run, from - shift, length);
  }
  const run = htmlRuns(source).filter((each) => each.value === data)[sameBefore];
  return run ? spanOf(run, from, length) : null;
}

/**
 * Markdown, where this checker has no source map of its own: the bytes that really differ
 * between the two files (found here, never the planner's range), widened to whole character
 * references and backslash escapes, must be spellings of the deleted and the inserted text and
 * of nothing else. A rewrite next to the selection, such as another spelling of a reference
 * the selection does not include, decodes to text outside the change and fails.
 */
function markdownChange(
  oldSource: string,
  newSource: string,
  deleted: string,
  inserted: string,
): string | null {
  let head = 0;
  while (head < oldSource.length && head < newSource.length && oldSource[head] === newSource[head])
    head++;
  let tail = 0;
  while (
    tail < oldSource.length - head &&
    tail < newSource.length - head &&
    oldSource[oldSource.length - 1 - tail] === newSource[newSource.length - 1 - tail]
  ) {
    tail++;
  }
  // A common prefix or suffix may end inside a reference or an escape both files spell alike at
  // first: take the whole spelling on each side.
  const opened = /(?:&[#a-z0-9]{0,40}|\\)$/i.exec(oldSource.slice(0, head));
  if (opened) head -= opened[0].length;
  const rest = oldSource.slice(oldSource.length - tail);
  const closing = /^[#a-z0-9]{0,40};/i.exec(rest);
  const before = oldSource.slice(
    Math.max(0, oldSource.length - tail - 40),
    oldSource.length - tail,
  );
  if (closing && /&[#a-z0-9]{0,40}$/i.test(before)) tail -= closing[0].length;
  // A backslash escape first, then a character reference, as Markdown reads its text.
  const spelled = (source: string) => {
    const end = source.length - tail;
    let text = "";
    for (let at = head; at < end; ) {
      const escaped = source[at] === "\\" ? source[at + 1] : undefined;
      if (escaped !== undefined && at + 1 < end && /[!-/:-@[-`{-~]/.test(escaped)) {
        text += escaped;
        at += 2;
        continue;
      }
      const reference = /^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.exec(source.slice(at, end));
      if (reference) {
        text += decodeReference(reference[0]);
        at += reference[0].length;
        continue;
      }
      text += source[at] === "\r" ? "\n" : source[at];
      at += source[at] === "\r" && source[at + 1] === "\n" ? 2 : 1;
    }
    return text;
  };
  // Where the text around a change repeats it, the differing bytes are the change rotated
  // ("a b a" losing " a" differs at "b a"): any stretch of the change repeated is its spelling.
  const within = (whole: string, part: string) =>
    part.length <= whole.length && (whole + whole).includes(part);
  if (!within(deleted, spelled(oldSource))) return "the file changed text outside the selection";
  if (!within(inserted, spelled(newSource))) return "the file gained text outside the insertion";
  return null;
}

/** The raw span of `length` decoded units from `from` in a run (a point for an insertion). */
function spanOf(run: Run, from: number, length: number): { start: number; end: number } {
  const first = from;
  const last = from + length;
  if (length === 0) {
    const point =
      first < run.value.length ? (run.rawStart[first] as number) : (run.rawEnd.at(-1) ?? 0);
    return { start: point, end: point };
  }
  return { start: run.rawStart[first] as number, end: run.rawEnd[last - 1] as number };
}

/** The path and offset of the reviewer's selection on the old page. */
function locate(
  body: Element,
  edit: TextEdit,
): { path: string; offset: number; data: string; sameBefore: number } | null {
  const document = new AnchorDocument(body as unknown as AnchorElement);
  const points = Array.from(document.text.value);
  const found = document.resolveText({
    kind: "text",
    quote: {
      exact: edit.before,
      prefix: points.slice(Math.max(0, edit.start - 32), edit.start).join(""),
      suffix: points.slice(edit.end, edit.end + 32).join(""),
    },
    position: { start: edit.start, end: edit.end },
  });
  if (found.confidence !== "exact") return null;
  const target = found.range.start.node as unknown as Node;
  let path: string | null = null;
  const visit = (node: Node, here: string) => {
    Array.from(node.childNodes).forEach((child, index) => {
      const at = `${here}/${child.nodeName.toLowerCase()}[${index}]`;
      if (child === target) path = at;
      else visit(child, at);
    });
  };
  visit(body.parentNode as unknown as Node, "html");
  if (path === null) return null;
  const data = (target as unknown as Text).data;
  // How many text nodes with the same text come before it, across the whole document.
  let sameBefore = 0;
  let passed = false;
  const count = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (passed) return;
      if (child === target) passed = true;
      else if (child.nodeType === 3 && (child as Text).data === data) sameBefore++;
      else count(child);
    }
  };
  count(body.parentNode as unknown as Node);
  return { path, offset: found.range.start.offset, data, sameBefore };
}

/**
 * Why a planner's result is wrong, or null when it is right: the old file with the approved
 * change, nothing else of the page changed, and the edited text node changed exactly at the
 * reviewer's location.
 */
export async function check(
  kind: FileKind,
  oldSource: string,
  newSource: string,
  edit: TextEdit,
  range: Range,
): Promise<string | null> {
  if (!sameOutside(oldSource, newSource, range)) return "bytes outside the approved range";
  if (!rangeHolds(kind, oldSource, newSource, range)) return "the approved range is not the change";
  const oldPage = await pageOf(kind, oldSource);
  const newPage = await pageOf(kind, newSource);
  if (ids(oldPage).join("\n") !== ids(newPage).join("\n")) return "an ID or a reference changed";
  if (markup(oldPage) !== markup(newPage)) return "the markup changed";
  const oldDocument = parseDocument(oldPage);
  const oldBody = oldDocument.body;
  const before = witness(oldDocument.documentElement as unknown as Node);
  const after = witness(parseDocument(newPage).documentElement as unknown as Node);
  if ([...before.keys()].join("\n") !== [...after.keys()].join("\n")) return "text nodes moved";
  const at = locate(oldBody, edit);
  if (!at) return "the checker could not place the edit";
  const change = changed(edit);
  const old = before.get(at.path) as string;
  const from = at.offset + change.prefix.length;
  if (old.slice(from, from + change.deleted.length) !== change.deleted) {
    return "the selection is not raw text at the reviewer's location";
  }
  if (kind !== "markdown") {
    // The bytes may change only inside the interval the selected text occupies in the file, and
    // what replaces them must decode to the inserted text.
    const allowed = allowedInterval(
      kind,
      oldSource,
      at.data,
      at.sameBefore,
      from,
      change.deleted.length,
    );
    if (!allowed) return "the checker could not map the selection to the file";
    const tail = oldSource.length - allowed.end;
    if (
      newSource.slice(0, allowed.start) !== oldSource.slice(0, allowed.start) ||
      newSource.slice(newSource.length - tail) !== oldSource.slice(allowed.end) ||
      newSource.length - tail < allowed.start
    ) {
      return "bytes changed outside the selected text";
    }
    const written = newSource.slice(allowed.start, newSource.length - tail);
    const decoded = decodeRun(written, 0, written.length, kind === "html").value;
    if (decoded !== change.inserted) return "the written text is not the inserted text";
  }
  for (const [path, data] of before) {
    const expected =
      path === at.path
        ? old.slice(0, from) + change.inserted + old.slice(from + change.deleted.length)
        : data;
    if (after.get(path) !== expected) return `text changed at ${path}`;
  }
  if (kind === "markdown") {
    const outside = markdownChange(oldSource, newSource, change.deleted, change.inserted);
    if (outside) return outside;
    // The change stays inside one block of the old block map.
    const { blocks } = await storedOf("markdown", oldSource);
    const inside = blocks.some((block) => block.start <= range.start && range.end <= block.end);
    if (!inside) return "the change crosses blocks";
  }
  return null;
}
