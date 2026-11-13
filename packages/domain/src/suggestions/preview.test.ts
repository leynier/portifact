import { describe, expect, it } from "vitest";
import { previewDocument, RENDERER } from "../testing/suggestions/harness.ts";
import { buildPreview, PREVIEW_POLICY, previewable, previewHeaders } from "./preview.ts";
import { newWork } from "./work.ts";

const HOSTILE =
  '<!-- <head> --><html><head><title>x</title><base href="https://e.example"><meta http-equiv="refresh" content="0;url=https://e.example"><link rel="stylesheet" href="s.css"><style>p{background:url(x.png)}@keyframes k{}</style><script>1</script></head><body><header>x</header><img src="x.png" alt="Chart"><img src="y.png"><a href="/pay">Pay</a><form action="/x"><input name="x"></form><iframe src="/f"></iframe><svg><image href="x.png"/></svg><template shadowrootmode="open"><img src="y.png"></template><script>1</script><video src="v.mp4"></video><p style="color:red" onclick="1" xlink:href="x">ok</p><unknown-element><b>kept</b></unknown-element><br><hr><table><colgroup><col span="2"></colgroup></table></body></html>';

describe("previews are built documents that load nothing", () => {
  it("are built under one policy for every kind, with nothing that loads or navigates", () => {
    for (const [kind, source] of [
      [
        "markdown",
        "# Hi\n\n![a](secret.png) [link](https://evil.example)\n\n```mermaid\nA-->B\n```",
      ],
      ["text", "<img src=x>"],
      ["html", HOSTILE],
    ] as const) {
      const html = previewDocument(kind, source);
      expect(html).toContain(`content="${PREVIEW_POLICY}"`);
      expect(html.indexOf(PREVIEW_POLICY)).toBeLessThan(html.indexOf("<body>"));
      expect(html).not.toMatch(/<[^>]*\s(src|href|srcset|action|formaction|poster|onclick)=/i);
      expect(html).not.toMatch(
        /<(script|iframe|form|input|base|link|svg|template|video|object|embed|title)\b/i,
      );
      expect(html).toContain("animation:none!important");
    }
    const hostile = previewDocument("html", HOSTILE);
    expect(hostile).toContain("<span data-preview-image>Chart</span>");
    expect(hostile).toContain("<b>kept</b>");
    expect(hostile).toContain('<p style="color:red">ok</p>');
    expect(hostile).toContain("<br><hr>");
    expect(hostile).toContain('<col span="2"></colgroup>');
    expect(hostile).toContain("<style>p{background:url(x.png)}@keyframes k{}</style>");
  });

  it("keeps no resource attribute when the head is hidden in a comment or a header", () => {
    for (const html of [
      '<!-- <head> --><html><head><title>x</title></head><body><img src="x.png"></body></html>',
      '<html><body><header>x</header><img src="x.png"></body></html>',
    ]) {
      expect(previewDocument("html", html)).not.toMatch(/\ssrc=/);
    }
  });

  it("keeps the file's styles from closing their element, and escapes text and attributes", () => {
    const html = previewDocument(
      "html",
      '<html><head><style>p::after{content:"</style><script>1</script>"}</style></head><body><p title="a&quot;b">x &lt; y</p></body></html>',
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain('<p title="a&quot;b">x &lt; y</p>');
  });

  it("writes a deep page without exhausting the stack", () => {
    const deep = `<html><body>${"<div>".repeat(20_000)}x${"</div>".repeat(20_000)}</body></html>`;
    expect(previewDocument("html", deep)).toContain("x");
  });

  it("counts its work and tells which files are small enough", () => {
    const work = newWork();
    previewDocument("markdown", "a", work);
    previewDocument("html", "<p>a</p>", work);
    expect(work).toMatchObject({ renders: 1, parses: 2 });
    expect(previewable("html", "x".repeat(1_048_576))).toBe(true);
    expect(previewable("html", "é".repeat(600_000))).toBe(false);
    expect(previewable("markdown", "x".repeat(2_000_001))).toBe(false);
    expect(previewable("text", "x")).toBe(true);
  });

  it("are served with a policy that frames them only in the app, uncached", () => {
    const headers = previewHeaders("https://app.portifact.com");
    expect(headers["Content-Security-Policy"]).toBe(
      `${PREVIEW_POLICY}; frame-ancestors https://app.portifact.com; sandbox`,
    );
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });
});
