// axe-core in a real browser, so color contrast is checked too (happy-dom has no layout). The
// script goes in through Playwright's evaluate, which the pages' strict CSP does not apply to,
// so the pages need no allowance for it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "@playwright/test";

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

export interface AxeViolation {
  id: string;
  targets: string[];
}

interface AxeWindow {
  axe: {
    run(
      context: Document,
      options: { resultTypes: string[] },
    ): Promise<{ violations: { id: string; nodes: { target: unknown[] }[] }[] }>;
  };
}

/** The axe violations of the page as it is now, in its current color scheme. */
export async function axeViolations(page: Page): Promise<AxeViolation[]> {
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async () => {
    const { axe } = window as unknown as AxeWindow;
    const result = await axe.run(document, { resultTypes: ["violations"] });
    return result.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    }));
  });
}
