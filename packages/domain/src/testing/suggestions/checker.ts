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

/** Text nodes of the body at their DOM paths, in document order. */
function witness(body: Node): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (node: Node, path: string) => {
    Array.from(node.childNodes).forEach((child, index) => {
      const here = `${path}/${child.nodeName.toLowerCase()}[${index}]`;
      if (child.nodeType === 3) found.set(here, (child as Text).data);
      else visit(child, here);
    });
  };
  visit(body, "body");
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

/** The path and offset of the reviewer's selection on the old page. */
function locate(body: Element, edit: TextEdit): { path: string; offset: number } | null {
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
  visit(body, "body");
  return path === null ? null : { path, offset: found.range.start.offset };
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
  const oldPage = await pageOf(kind, oldSource);
  const newPage = await pageOf(kind, newSource);
  if (ids(oldPage).join("\n") !== ids(newPage).join("\n")) return "an ID or a reference changed";
  if (markup(oldPage) !== markup(newPage)) return "the markup changed";
  const oldBody = parseDocument(oldPage).body;
  const before = witness(oldBody);
  const after = witness(parseDocument(newPage).body);
  if ([...before.keys()].join("\n") !== [...after.keys()].join("\n")) return "text nodes moved";
  const at = locate(oldBody, edit);
  if (!at) return "the checker could not place the edit";
  const change = changed(edit);
  const old = before.get(at.path) as string;
  const from = at.offset + change.prefix.length;
  if (old.slice(from, from + change.deleted.length) !== change.deleted) {
    return "the selection is not raw text at the reviewer's location";
  }
  for (const [path, data] of before) {
    const expected =
      path === at.path
        ? old.slice(0, from) + change.inserted + old.slice(from + change.deleted.length)
        : data;
    if (after.get(path) !== expected) return `text changed at ${path}`;
  }
  if (kind === "markdown") {
    // The change stays inside one block of the old block map.
    const { blocks } = await storedOf("markdown", oldSource);
    const inside = blocks.some((block) => block.start <= range.start && range.end <= block.end);
    if (!inside) return "the change crosses blocks";
  }
  return null;
}
