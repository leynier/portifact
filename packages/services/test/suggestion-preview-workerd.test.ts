// The preview builder of decision 0027 in workerd, where css-tree's recursion meets the Worker's
// stack (second review of pull request #252, R8): deeply nested CSS gives a typed unavailable
// preview, never a thrown error and never a preview that keeps the CSS as it came.
import { buildPreview, PREVIEW_CSS_LIMITS, withoutMotion } from "@portifact/domain/suggestions";
import { DOCUMENT_RENDERER } from "@portifact/render";
import { describe, expect, it } from "vitest";

const page = (head: string, body = "<p>x</p>") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe("previews in workerd", () => {
  it("refuses 1,000 nested blocks with an unavailable preview", () => {
    const css = `${"@media all{".repeat(1_000)}p{animation:spin 1s!important}${"}".repeat(1_000)}`;
    expect(buildPreview("html", page(`<style>${css}</style>`), DOCUMENT_RENDERER)).toEqual({
      state: "unavailable",
      reason: "css_too_complex",
    });
    expect(() => withoutMotion(css, "stylesheet")).toThrow();
  });

  it("refuses deep inline styles and too much CSS on one page", () => {
    expect(
      buildPreview("html", page("", `<p style="${"x:(".repeat(1_000)}">x</p>`), DOCUMENT_RENDERER),
    ).toEqual({
      state: "unavailable",
      reason: "css_too_complex",
    });
    const many = Array.from(
      { length: 3 },
      () => `<style>${"p{color:red}".repeat(20_000)}</style>`,
    ).join("");
    expect(many.length).toBeGreaterThan(PREVIEW_CSS_LIMITS.units);
    expect(buildPreview("html", page(many), DOCUMENT_RENDERER).state).toBe("unavailable");
  });

  it("builds a page at the nesting limit, without its motion", () => {
    const depth = PREVIEW_CSS_LIMITS.depth - 1;
    const css = `${"@media all{".repeat(depth)}p{animation:spin 1s;color:red}${"}".repeat(depth)}`;
    const built = buildPreview("html", page(`<style>${css}</style>`), DOCUMENT_RENDERER);
    expect(built.state).toBe("ready");
    if (built.state === "ready") {
      expect(built.document).toContain("color:red");
      expect(built.document).not.toContain("animation:spin");
    }
  });
});
