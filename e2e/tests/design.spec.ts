// The dashboard's main screens in a real browser, in both themes: axe with color contrast on,
// which the component tests cannot check because happy-dom has no layout or computed colors.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "@playwright/test";
import { createUser, expect, publish, signIn, test } from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

// Evaluated through the automation protocol, which the dashboard's strict CSP does not block, so
// the test never weakens the policy it runs under.
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const PAGE = { "index.html": "<!doctype html><title>Page</title><p>Hello</p>" };

interface Violation {
  id: string;
  nodes: string[];
}

async function violations(page: Page): Promise<Violation[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run(
            context: Document,
            options: object,
          ): Promise<{ violations: { id: string; nodes: { html: string }[] }[] }>;
        };
      }
    ).axe;
    // Frames hold user content, which Portifact does not draw.
    const result = await axe.run(document, { iframes: false, resultTypes: ["violations"] });
    return result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.html) }));
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`the dashboard's main screens pass axe with color contrast in the ${scheme} theme`, async ({
    page,
    context,
  }) => {
    const owner = await createUser(`Designer${scheme}`);
    const { artifactId } = await publish({
      ownerId: owner.userId,
      name: "Launch plan",
      files: PAGE,
      accessMode: "authenticated",
    });
    await signIn(context, owner);
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const screens: [string, string][] = [
      ["/", "Artifacts"],
      [`/artifacts/${artifactId}`, "Launch plan"],
      ["/publish", "Publish"],
      [`/artifacts/${artifactId}/history`, "History of Launch plan"],
      ["/account", "Account"],
    ];
    for (const [path, title] of screens) {
      await page.goto(`${APP_ORIGIN}${path}`);
      await page.getByRole("heading", { level: 1, name: title }).waitFor();
      // Sections load on their own; wait until nothing says it is loading.
      await expect(page.getByText(/^Loading/)).toHaveCount(0);
      expect(await violations(page), `${path} in the ${scheme} theme`).toEqual([]);
    }

    // The first-publish guide of a new account.
    const fresh = await createUser(`Newcomer${scheme}`);
    await context.clearCookies();
    await signIn(context, fresh);
    await page.goto(`${APP_ORIGIN}/`);
    await page.getByRole("heading", { name: "No artifacts yet" }).waitFor();
    expect(await violations(page), `the empty list in the ${scheme} theme`).toEqual([]);
  });
}
