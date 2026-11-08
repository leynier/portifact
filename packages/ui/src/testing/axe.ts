// Accessibility check for component and screen tests (docs/accessibility.md). happy-dom has no
// layout or computed colors, so color contrast is checked on the tokens instead
// (src/tokens/tokens.test.ts) and in the end-to-end tests.
import axe from "axe-core";

export interface AxeViolation {
  id: string;
  help: string;
  nodes: string[];
}

/** Runs axe on `root` and returns its violations, empty when the markup passes. */
export async function axeViolations(root: Element): Promise<AxeViolation[]> {
  const results = await axe.run(root, {
    rules: { "color-contrast": { enabled: false } },
    resultTypes: ["violations"],
  });
  return results.violations.map((violation) => ({
    id: violation.id,
    help: violation.help,
    nodes: violation.nodes.map((node) => node.html),
  }));
}
