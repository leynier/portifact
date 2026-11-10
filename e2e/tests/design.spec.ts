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
      ["/profile", "Profile"],
      ["/apps", "Apps"],
      ["/usage", "Usage"],
      ["/plan", "Plan"],
      ["/settings", "Settings"],
    ];
    for (const [path, title] of screens) {
      await page.goto(`${APP_ORIGIN}${path}`);
      await page.getByRole("heading", { level: 1, name: title }).waitFor();
      // Sections load on their own; wait until nothing says it is loading.
      await expect(page.getByText(/^Loading/)).toHaveCount(0);
      expect(await violations(page), `${path} in the ${scheme} theme`).toEqual([]);
    }

    // The collapsed sidebar, and on a phone the open drawer.
    await page.goto(`${APP_ORIGIN}/`);
    await page.getByRole("heading", { level: 1 }).waitFor();
    await expect(page.getByText(/^Loading/)).toHaveCount(0);
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    expect(await violations(page), `the collapsed sidebar in the ${scheme} theme`).toEqual([]);
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await page.setViewportSize({ width: 375, height: 740 });
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("dialog", { name: "Open navigation" }).waitFor();
    expect(await violations(page), `the navigation drawer in the ${scheme} theme`).toEqual([]);
    await page.keyboard.press("Escape");

    // The first-publish guide of a new account.
    const fresh = await createUser(`Newcomer${scheme}`);
    await context.clearCookies();
    await signIn(context, fresh);
    await page.goto(`${APP_ORIGIN}/`);
    await page.getByRole("heading", { name: "No artifacts yet" }).waitFor();
    expect(await violations(page), `the empty list in the ${scheme} theme`).toEqual([]);
  });
}
