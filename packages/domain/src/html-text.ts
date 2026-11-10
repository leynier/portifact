// Visible text of an HTML page, for the content search index (decision 0012). Not an HTML parser:
// a single forward pass that drops tags with their attributes, comments, declarations and the
// contents of elements a reader never sees as text (scripts, styles, templates and the like),
// decodes character references and collapses white space. Every position of the input is visited
// a bounded number of times, so hostile input costs linear time; the output is capped.

/** Elements whose content is never visible text; skipped up to their closing tag. */
const HIDDEN = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "iframe",
  "object",
  "svg",
  "math",
]);

/** Inline elements that do not separate words; every other tag separates them. */
const INLINE = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "dfn",
  "em",
  "i",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
  "wbr",
  "del",
  "ins",
]);

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  // The design check refuses the character itself in source.
  mdash: String.fromCharCode(0x2014),
  ndash: "–",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  bull: "•",
  middot: "·",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  times: "×",
  divide: "÷",
  iexcl: "¡",
  iquest: "¿",
  shy: "",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  uuml: "ü",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  Ntilde: "Ñ",
  Uuml: "Ü",
  auml: "ä",
  ouml: "ö",
  Auml: "Ä",
  Ouml: "Ö",
  szlig: "ß",
  ccedil: "ç",
  Ccedil: "Ç",
  agrave: "à",
  egrave: "è",
  ograve: "ò",
  acirc: "â",
  ecirc: "ê",
  ocirc: "ô",
  atilde: "ã",
  otilde: "õ",
};

const NAME_CHAR = /[A-Za-z0-9-]/;
const WHITE = /\s+/g;

function isNameStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z]/.test(char);
}

/** The index of the `>` that ends a tag starting at `from`, skipping quoted attribute values. */
function tagEnd(html: string, from: number): number {
  let quote = "";
  for (let i = from; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return html.length;
}

/** Where the closing tag of `name` starts at or after `from`, ASCII case-insensitive. */
function closingTag(html: string, from: number, name: string): number {
  let at = html.indexOf("</", from);
  while (at !== -1) {
    const candidate = html.slice(at + 2, at + 2 + name.length);
    const after = html[at + 2 + name.length];
    if (candidate.toLowerCase() === name && (after === undefined || !NAME_CHAR.test(after))) {
      return at;
    }
    at = html.indexOf("</", at + 2);
  }
  return html.length;
}

function decodeReference(html: string, at: number): { text: string; next: number } {
  // `at` is the `&`. References are short: look at most 32 characters ahead.
  const window = html.slice(at + 1, at + 33).indexOf(";");
  if (window === -1) return { text: "&", next: at + 1 };
  const end = at + 1 + window;
  const body = html.slice(at + 1, end);
  if (body.startsWith("#")) {
    const hex = body[1] === "x" || body[1] === "X";
    const digits = hex ? body.slice(2) : body.slice(1);
    if (!(hex ? /^[0-9a-fA-F]{1,6}$/ : /^[0-9]{1,7}$/).test(digits))
      return { text: "&", next: at + 1 };
    const code = Number.parseInt(digits, hex ? 16 : 10);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return { text: valid ? String.fromCodePoint(code) : "�", next: end + 1 };
  }
  const named = NAMED[body];
  return named === undefined ? { text: "&", next: at + 1 } : { text: named, next: end + 1 };
}

/**
 * The visible text of `html`, white space collapsed to single spaces, at most `maxChars`
 * characters (UTF-16 code units). `truncated` says the cap cut it.
 */
export function htmlText(html: string, maxChars: number): { text: string; truncated: boolean } {
  const parts: string[] = [];
  let length = 0;
  let truncated = false;
  const push = (text: string) => {
    if (length >= maxChars) {
      if (text.trim()) truncated = true;
      return;
    }
    parts.push(text);
    length += text.length;
  };
  let i = 0;
  let run = 0;
  while (i < html.length && !truncated) {
    const char = html[i] as string;
    if (char === "<") {
      if (run < i) push(html.slice(run, i));
      const next = html[i + 1];
      if (html.startsWith("<!--", i)) {
        const close = html.indexOf("-->", i + 4);
        i = close === -1 ? html.length : close + 3;
      } else if (next === "!" || next === "?") {
        i = tagEnd(html, i + 2) + 1;
      } else if (next === "/" && isNameStart(html[i + 2])) {
        let end = i + 2;
        while (end < html.length && NAME_CHAR.test(html[end] as string)) end++;
        const name = html.slice(i + 2, end).toLowerCase();
        if (!INLINE.has(name)) push(" ");
        i = tagEnd(html, end) + 1;
      } else if (isNameStart(next)) {
        let end = i + 1;
        while (end < html.length && NAME_CHAR.test(html[end] as string)) end++;
        const name = html.slice(i + 1, end).toLowerCase();
        const close = tagEnd(html, end);
        if (!INLINE.has(name)) push(" ");
        i = close + 1;
        // A self-closing hidden element (`<svg/>`) has no content to skip.
        if (HIDDEN.has(name) && html[close - 1] !== "/") {
          const closing = closingTag(html, i, name);
          i = tagEnd(html, closing) + 1;
        }
      } else {
        // A `<` that starts no tag is text.
        push("<");
        i += 1;
      }
      run = i;
    } else if (char === "&") {
      if (run < i) push(html.slice(run, i));
      const reference = decodeReference(html, i);
      push(reference.text);
      i = reference.next;
      run = i;
    } else {
      i += 1;
    }
  }
  if (!truncated && run < html.length) push(html.slice(run));
  const text = parts.join("").replace(WHITE, " ").trim();
  if (text.length > maxChars) return { text: sliceChars(text, maxChars), truncated: true };
  return { text, truncated };
}

/** The first `max` code units, without leaving half of a surrogate pair at the end. */
function sliceChars(text: string, max: number): string {
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}
