// Dashboard flows end to end: the artifact list's search and filters, applied by the API and
// kept in the URL, and the review viewer's comment filters and export.

import { readFile } from "node:fs/promises";
import { control, createUser, expect, openReview, publish, signIn, test } from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const PAGE = { "index.html": "<!doctype html><title>Page</title><p>Hello</p>" };

test("the artifact list searches and filters from the keyboard, and keeps them in the URL", async ({
  page,
  context,
}) => {
  const owner = await createUser("Lister");
  await publish({ ownerId: owner.userId, name: "Launch plan", files: PAGE });
  await publish({
    ownerId: owner.userId,
    type: "markdown",
    name: "Launch notes",
    files: { "index.md": "# Notes" },
  });
  await publish({ ownerId: owner.userId, name: "Budget", files: PAGE, accessMode: "public" });
  await signIn(context, owner);
  await page.goto(`${APP_ORIGIN}/`);
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(4);

  const search = page.getByRole("searchbox", { name: "Search" });
  await search.focus();
  await page.keyboard.type("launch");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${APP_ORIGIN}/?search=launch`);
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(page.getByText("Showing 2 matching artifacts")).toBeVisible();
  // Focus stays in the form after a search.
  await expect(search).toBeFocused();

  await page.getByRole("combobox", { name: "Type" }).selectOption("markdown");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("link", { name: "Launch notes" })).toBeVisible();

  // The URL carries the filters to a new load, and back returns to the earlier search.
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Type" })).toHaveValue("markdown");
  await expect(table.getByRole("row")).toHaveCount(2);
  await page.goBack();
  await expect(table.getByRole("row")).toHaveCount(3);

  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("combobox", { name: "Access" }).selectOption("public");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("link", { name: "Budget" })).toBeVisible();
});

test("the review viewer filters comments by author and exports them as Markdown", async ({
  page,
  context,
}) => {
  const owner = await createUser("Exporter");
  const reviewer = await createUser("Reviewer");
  const { artifactId, versionId } = await publish({
    ownerId: owner.userId,
    name: "Export plan",
    files: PAGE,
    // The reviewer must be able to read it to comment.
    accessMode: "authenticated",
  });
  for (const [author, body] of [
    [owner, "Owner note"],
    [reviewer, "Reviewer note"],
  ] as const) {
    await control("/thread", {
      userId: author.userId,
      artifactId,
      versionId,
      path: "index.html",
      body,
    });
  }
  await signIn(context, owner);
  await openReview(page, artifactId, "Export plan");
  await expect(page.getByText("2 comment threads")).toBeVisible();

  await page.getByRole("combobox", { name: "Author" }).selectOption({ label: "You" });
  await expect(page.getByText("Showing 1 of 2 comment threads")).toBeVisible();
  await expect(page.getByText("Owner note")).toBeVisible();
  await expect(page.getByText("Reviewer note")).toBeHidden();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export as Markdown" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${artifactId}-annotations.md`);
  const text = await readFile(await file.path(), "utf8");
  // The export covers every author of the version: the author filter is the panel's alone.
  expect(text).toContain("Owner note");
  expect(text).toContain("Reviewer note");
});
