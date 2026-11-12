// A deterministic corpus of Markdown documents and of edits a reviewer could make on their
// rendered pages: plain words, punctuation, hostile text that is Markdown or HTML syntax, and
// selections that cross inline formatting and block boundaries.
import { codePoints } from "../src/page.ts";

/** Mulberry32: a small seeded generator, so every run tests the same corpus. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export const pick = <T>(rand: () => number, items: readonly T[]): T =>
  items[Math.floor(rand() * items.length)] as T;

const WORDS = [
  "review",
  "artifact",
  "version",
  "quota",
  "anchor",
  "budget",
  "draft",
  "owner",
  "reader",
  "publish",
  "region",
  "the",
  "a",
  "of",
  "café",
  "naïve",
  "東京",
  "日本語",
  "😀",
  "2026",
  "v1.2",
  "e-mail",
];

const sentence = (rand: () => number, words = 6 + Math.floor(rand() * 10)) =>
  Array.from({ length: words }, () => pick(rand, WORDS)).join(" ");

/** One block of Markdown, chosen among the shapes the corpus must cover. */
function block(rand: () => number, index: number): string {
  const s = () => sentence(rand);
  switch (Math.floor(rand() * 16)) {
    case 0:
      return `${"#".repeat(1 + Math.floor(rand() * 3))} ${sentence(rand, 4)}`;
    case 1:
      return `${s()} **${sentence(rand, 2)}** ${s()} *${sentence(rand, 2)}* ${s()}.`;
    case 2:
      return `${s()} \`${sentence(rand, 2)}\` and [${sentence(rand, 3)}](https://example.com/${index}) ${s()}.`;
    case 3:
      return `- ${s()}\n- ${s()}\n  - ${s()}\n- ${s()}`;
    case 4:
      return `1. ${s()}\n2. ${s()}\n3. ${s()}`;
    case 5:
      return `| ${sentence(rand, 2)} | ${sentence(rand, 2)} |\n| --- | --- |\n| ${sentence(rand, 3)} | ${sentence(rand, 3)} |\n| ${sentence(rand, 3)} | ${sentence(rand, 3)} |`;
    case 6:
      return `\`\`\`ts\nconst ${pick(rand, ["a", "b", "c"])} = "${s()}";\nfunction ${pick(rand, ["f", "g"])}() { return ${index}; }\n\`\`\``;
    case 7:
      return `> ${s()}\n> ${s()}`;
    case 8:
      return `${s()} &amp; ${s()} &copy; ${sentence(rand, 3)} &#169; ${s()}.`;
    case 9:
      // Repeated text: the same sentence in several blocks of the document.
      return "The same sentence appears in many places of this document.";
    case 10:
      return `${s()}[^${index}] ${s()}.\n\n[^${index}]: ${s()}.`;
    case 11:
      return `- [ ] ${s()}\n- [x] ${s()}`;
    case 12:
      return `${s()}\n${s()}\n${s()}`;
    case 13:
      return `${s()} https://example.org/${index} ${s()} www.example.net ${s()}.`;
    case 14:
      return `${s()} ~~${sentence(rand, 2)}~~ ${s()} _${sentence(rand, 2)}_ ${s()}.`;
    default:
      return `${s()}.`;
  }
}

export function markdownDocument(seed: number, blocks: number): string {
  const rand = random(seed);
  return Array.from({ length: blocks }, (_, index) => block(rand, index)).join("\n\n");
}

/** Text a reviewer might type: plain words, punctuation, and Markdown or HTML syntax. */
export const HOSTILE_AFTERS = [
  "**bold**",
  "_em_",
  "`code`",
  "[link](javascript:alert(1))",
  "[x](https://evil.example)",
  "![img](https://evil.example/p.png)",
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(1)">',
  "<b>tag</b>",
  "# heading",
  "- item",
  "1. item",
  "> quote",
  "| a | b |",
  "---",
  "&lt;",
  "&amp;copy;",
  "\\",
  "\\*",
  "[^1]",
  "<https://evil.example>",
  "https://evil.example",
  "www.evil.example",
  "a@evil.example",
  "~~gone~~",
  "* * *",
  "```",
  "[ref]: https://evil.example",
  "x <!-- c --> y",
];

export const PLAIN_AFTERS = [
  "reviewed",
  "the new budget",
  "café 2026",
  "日本語の文書",
  "a, b; c.",
  "(see 3)",
  'it\'s "quoted"',
];

export interface CorpusEdit {
  start: number;
  end: number;
  before: string;
  after: string;
}

/** A random selection of whole words in the page text, and a replacement. */
export function randomEdit(
  rand: () => number,
  text: string,
  afters: readonly string[],
): CorpusEdit | null {
  const points = codePoints(text);
  const spaces = [0];
  points.forEach((point, index) => {
    if (point === " ") spaces.push(index + 1);
  });
  if (spaces.length < 2) return null;
  const first = Math.floor(rand() * (spaces.length - 1));
  // Mostly one to three words; sometimes longer, which crosses formatting and blocks.
  const span = rand() < 0.85 ? 1 + Math.floor(rand() * 3) : 4 + Math.floor(rand() * 25);
  const start = spaces[first] as number;
  const endIndex = Math.min(spaces.length - 1, first + span);
  let end = (spaces[endIndex] as number) - 1;
  if (endIndex === spaces.length - 1 && first + span >= spaces.length - 1) end = points.length;
  if (end <= start) return null;
  const before = points.slice(start, end).join("");
  // Some edits replace one word inside the selection, the shape most reviews take.
  let after = pick(rand, afters);
  if (rand() < 0.3) {
    const words = before.split(" ");
    words[Math.floor(rand() * words.length)] = after;
    after = words.join(" ");
  }
  if (after === before || /\s{2}/.test(after)) return null;
  return { start, end, before, after };
}
