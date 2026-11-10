// Comparing versions end to end (premium plan P3): on the free plan the history says how many
// versions are kept and that comparing is part of a paid plan; on Pro the owner picks two
// versions, sees the files that differ and a file's changes unified and side by side.

import { axeViolations } from "../src/axe.ts";
import { createUser, expect, publish, signIn, sql, test } from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plan</title></head><body><main>\n${body}\n</main></body></html>\n`;

test("an owner on Pro compares two versions file by file and line by line", async ({
  page: browser,
  context,
}) => {
  const owner = await createUser("Owner");
  const first = await publish({
    ownerId: owner.userId,
    name: "Plan",
    bar: false,
    files: { "index.html": page("<h1>Plan</h1>\n<p>Ship in May.</p>"), "notes.txt": "draft\n" },
  });
  await publish({
    ownerId: owner.userId,
    name: "Plan",
    bar: false,
    files: { "index.html": page("<h1>Plan</h1>\n<p>Ship in June.</p>"), "todo.txt": "later\n" },
    update: { artifactId: first.artifactId, baseVersionId: first.versionId },
  });
  await signIn(context, owner);

  // Free: the retention of the free plan and a note, no comparison.
  await browser.goto(`${APP_ORIGIN}/artifacts/${first.artifactId}/history`);
  await expect(
    browser.getByText(
      "The owner's plan keeps 2 previous versions for 7 days after each one is replaced.",
    ),
  ).toBeVisible();
  const compare = browser.getByRole("region", { name: "Compare versions" });
  await expect(
    compare.getByText(
      "Comparing versions and keeping more of them for longer are part of the Pro plan.",
    ),
  ).toBeVisible();
  await expect(compare.getByRole("button", { name: "Compare" })).toHaveCount(0);

  // On Pro, granted as the operator tool would.
  await sql(
    "INSERT INTO owner_plans (owner_id, plan, seats, granted_by, updated_at) VALUES (?, 'pro', 1, 'operator', ?)",
    [owner.userId, Date.now()],
  );
  await browser.reload();
  await expect(
    browser.getByText(
      "The owner's plan keeps 50 previous versions for 90 days after each one is replaced.",
    ),
  ).toBeVisible();
  await compare.getByRole("button", { name: "Compare" }).click();
  await expect(
    compare.getByText(
      "Version 1 compared with version 2. Added: 1. Removed: 1. Changed: 1. Unchanged: 0.",
    ),
  ).toBeVisible();
  const files = compare.getByRole("table", {
    name: "Files that differ between version 1 and version 2",
  });
  await expect(files.getByRole("row")).toHaveCount(4);
  expect(await axeViolations(browser)).toEqual([]);

  // The keyboard reaches the changes of one file, and focus moves to them.
  await compare.getByRole("button", { name: "Show changes to index.html" }).focus();
  await browser.keyboard.press("Enter");
  const heading = compare.getByRole("heading", { name: "Changes to index.html" });
  await expect(heading).toBeFocused();
  const diff = compare.getByRole("table", {
    name: "Changes to index.html from version 1 to version 2",
  });
  await expect(
    diff.getByRole("row").filter({ hasText: "Removed: <p>Ship in May.</p>" }),
  ).toHaveCount(1);
  await expect(
    diff.getByRole("row").filter({ hasText: "Added: <p>Ship in June.</p>" }),
  ).toHaveCount(1);
  expect(await axeViolations(browser)).toEqual([]);

  await compare.getByRole("radio", { name: "Side by side" }).check();
  await expect(diff.getByRole("columnheader")).toHaveText(["Before", "After"]);
  expect(await axeViolations(browser)).toEqual([]);

  // In dark mode too.
  await browser.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  expect(await axeViolations(browser)).toEqual([]);
});
