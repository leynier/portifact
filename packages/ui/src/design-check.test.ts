import { describe, expect, it } from "vitest";
import { checkFile, isTokenSource } from "./design-check.ts";

const rules = (file: string, content: string) => checkFile(file, content).map((v) => v.rule);

describe("design-system check", () => {
  it("flags arbitrary Tailwind values in markup and scripts", () => {
    expect(rules("apps/web/index.html", '<div class="p-[13px]">')).toEqual([
      "arbitrary Tailwind value",
    ]);
    expect(rules("apps/web/src/x.tsx", 'className="text-[#333]"')).toEqual([
      "arbitrary Tailwind value",
    ]);
  });

  it("flags inline style attributes", () => {
    expect(rules("apps/web/index.html", '<p style="color: red">')).toEqual([
      "inline style attribute",
    ]);
  });

  it("allows inline styles only in email templates, which still get every other rule", () => {
    expect(rules("packages/emails/src/layout.ts", '<td style="padding: 0">')).toEqual([]);
    expect(rules("packages/emails/src/layout.ts", "<p>Hi \u2014 there</p>")).toEqual([
      "em dash in copy",
    ]);
    expect(rules("packages/emailsx/src/a.ts", '<td style="padding: 0">')).toEqual([
      "inline style attribute",
    ]);
  });

  it("flags em dashes in copy", () => {
    expect(rules("a.html", "<p>Fast \u2014 and private</p>")).toEqual(["em dash in copy"]);
  });

  it("flags Tailwind default palette colors", () => {
    expect(rules("a.html", '<p class="bg-blue-500">')).toEqual(["Tailwind default palette color"]);
    expect(rules("a.html", '<p class="text-white">')).toEqual(["Tailwind default palette color"]);
  });

  it("allows token-based utilities and ordinary markup", () => {
    const html = [
      '<body class="min-h-screen bg-canvas text-text">',
      '<a href="#features" class="text-text-muted hover:text-text">Features</a>',
      '<pre class="font-mono text-sm"><code id="x">a[1]</code></pre>',
      "const list = items[0];",
    ].join("\n");
    expect(checkFile("apps/web/index.html", html)).toEqual([]);
  });

  it("flags raw colors in stylesheets with file and line", () => {
    const css = "a {\n  color: #ff0000;\n  background: rgb(0 0 0);\n}";
    expect(checkFile("apps/web/src/main.css", css)).toEqual([
      { file: "apps/web/src/main.css", line: 2, rule: "raw color value", text: "color: #ff0000;" },
      {
        file: "apps/web/src/main.css",
        line: 3,
        rule: "raw color value",
        text: "background: rgb(0 0 0);",
      },
    ]);
  });

  it("allows stylesheets that only use tokens", () => {
    expect(checkFile("x.css", "a { color: var(--pf-color-text); }")).toEqual([]);
  });

  it("only treats the token sources as allowed to hold raw values", () => {
    expect(isTokenSource("packages/ui/src/tokens/tokens.css")).toBe(true);
    expect(isTokenSource("/repo/packages/ui/src/tokens/theme.css")).toBe(true);
    expect(isTokenSource("apps/web/src/main.css")).toBe(false);
  });
});
