// Finds styling that bypasses the design system (see docs/design.md, "Rules").

export interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

const TAILWIND_PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white";

const MARKUP_RULES: { rule: string; pattern: RegExp }[] = [
  { rule: "arbitrary Tailwind value", pattern: /(?<![\w-])[a-z][\w-]*-\[[^\]\s]+\]/ },
  { rule: "inline style attribute", pattern: /\sstyle\s*=/ },
  { rule: "em dash in copy", pattern: /\u2014/ },
  {
    rule: "Tailwind default palette color",
    pattern: new RegExp(
      `(?<![\\w-])(?:bg|text|border|fill|stroke|ring|outline|decoration|divide|from|via|to)-(?:${TAILWIND_PALETTE})(?:-\\d{2,3})?(?![\\w-])`,
    ),
  },
];

const STYLESHEET_RULES: { rule: string; pattern: RegExp }[] = [
  { rule: "raw color value", pattern: /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch)\(/i },
];

/** Checks one file. Stylesheets get the color rules; markup and scripts get the class rules. */
export function checkFile(file: string, content: string): Violation[] {
  const rules = file.endsWith(".css") ? STYLESHEET_RULES : MARKUP_RULES;
  const violations: Violation[] = [];
  content.split("\n").forEach((text, index) => {
    for (const { rule, pattern } of rules) {
      if (pattern.test(text)) violations.push({ file, line: index + 1, rule, text: text.trim() });
    }
  });
  return violations;
}

/** Files that may hold raw design values: only the token sources themselves. */
export function isTokenSource(file: string): boolean {
  return /(^|\/)packages\/ui\/src\/tokens\//.test(file);
}
