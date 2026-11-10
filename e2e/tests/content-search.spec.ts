// Content search end to end (premium plan T8, decision 0012): an owner on Team publishes a site,
// the commit's job indexes its visible text, and the dashboard's list finds it by a word inside
// the page, with the file and a highlighted snippet, in both themes with axe.

import { axeViolations } from "../src/axe.ts";
import {
  createUser,
  expect,
  grantPlan,
  publish,
  runSearchIndexing,
  signIn,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const SITE = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plan</title></head><body><main><h1>Launch</h1><p>The quarterly roadmap for the platform team.</p><script>var hiddenword = 1;</script></main></body></html>',
};

test("an owner on Team finds an artifact by a word in its page", async ({ page }) => {
  const owner = await createUser("Searcher");
  await grantPlan(owner.userId, "team");
  const { artifactId } = await publish({ ownerId: owner.userId, name: "Launch plan", files: SITE });
  const { outcomes } = await runSearchIndexing();
  expect(outcomes).toContain("done");

  await signIn(page.context(), owner);
  await page.goto(`${APP_ORIGIN}/`);
  await page.getByRole("checkbox", { name: /Search inside content/ }).check();
  const search = page.getByRole("searchbox", { name: "Search inside content" });
  await search.fill("roadmap");
  await search.press("Enter");

  const results = page.getByRole("table", { name: "Artifacts whose text matches the search" });
  await expect(results).toBeVisible();
  await expect(page).toHaveURL(/in=content/);
  const row = results.getByRole("row").nth(1);
  await expect(row.getByRole("link", { name: "Launch plan", exact: true })).toHaveAttribute(
    "href",
    `/artifacts/${artifactId}`,
  );
  await expect(row).toContainText("In index.html");
  await expect(row.locator("mark")).toHaveText(["roadmap"]);
  await expect(page.getByRole("status").filter({ hasText: "whose text matches" })).toHaveText(
    "Showing 1 artifact whose text matches",
  );
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    expect(await axeViolations(page), colorScheme).toEqual([]);
  }

  // A script's text is not visible text: nothing matches it.
  await search.fill("hiddenword");
  await search.press("Enter");
  await expect(page.getByText("No artifact's text matches")).toBeVisible();
});
