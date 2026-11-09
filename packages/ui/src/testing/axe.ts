// Accessibility check for component and screen tests (docs/accessibility.md). happy-dom has no
// layout or computed colors, so color contrast is checked on the tokens instead
// (src/tokens/tokens.test.ts) and in the end-to-end tests.
import axe from "axe-core";

export interface AxeViolation {
  id: string;
  help: string;
  nodes: string[];
}

/**
 * Runs axe on `root` and returns its violations, empty when the markup passes. Frames are not
 * entered: the only ones the product draws hold rendered user documents (`PreviewFrame`), whose
 * markup the renderer's own tests check, and happy-dom cannot message into them.
 */
export async function axeViolations(root: Element): Promise<AxeViolation[]> {
  const results = await axe.run(root, {
    iframes: false,
    rules: { "color-contrast": { enabled: false } },
    resultTypes: ["violations"],
  });
  return results.violations.map((violation) => ({
    id: violation.id,
    help: violation.help,
    nodes: violation.nodes.map((node) => node.html),
  }));
}

export { resetViewport, setViewportWidth } from "./viewport.ts";
