// Dashboard flows end to end: the artifact list's search and filters, applied by the API and
// kept in the URL, each artifact's activity in the list, the conversations on earlier versions in
// the history, and the viewer's comment filters and export.

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

  // A filter applies as soon as it is chosen, here from the keyboard: open, type, Enter.
  const type = page.getByRole("combobox", { name: "Type" });
  await type.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox", { name: "Type" })).toBeVisible();
  await page.keyboard.type("mark");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox", { name: "Type" })).toBeHidden();
  await expect(type).toBeFocused();
  await expect(page).toHaveURL(`${APP_ORIGIN}/?search=launch&type=markdown`);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("link", { name: "Launch notes", exact: true })).toBeVisible();

  // The URL carries the filters to a new load, and back returns to the earlier search.
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Type" })).toContainText("Markdown");
  await expect(table.getByRole("row")).toHaveCount(2);
  await page.goBack();
  await expect(table.getByRole("row")).toHaveCount(3);

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(`${APP_ORIGIN}/`);
  await page.getByRole("combobox", { name: "Access" }).click();
  await page.getByRole("option", { name: "Public" }).click();
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("link", { name: "Budget", exact: true })).toBeVisible();
});

test("the viewer filters comments by author and exports them as Markdown", async ({
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

  // The filters and export sit in a collapsed disclosure in the sidebar.
  await page.getByText("Filter and export", { exact: true }).click();
  await page.getByRole("combobox", { name: "Author" }).click();
  await page.getByRole("option", { name: "You", exact: true }).click();
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

test("the list shows each artifact's activity, and the history its earlier conversations", async ({
  page,
  context,
}) => {
  const owner = await createUser("Historian");
  const reviewer = await createUser("Critic");
  const first = await publish({
    ownerId: owner.userId,
    name: "Roadmap",
    files: PAGE,
    accessMode: "authenticated",
  });
  for (const body of ["Move the launch", "Typo in the title"]) {
    await control("/thread", {
      userId: reviewer.userId,
      artifactId: first.artifactId,
      versionId: first.versionId,
      path: "index.html",
      body,
    });
  }
  const second = await publish({
    ownerId: owner.userId,
    name: "Roadmap",
    files: { "index.html": "<!doctype html><title>Page</title><p>Hello again</p>" },
    update: { artifactId: first.artifactId, baseVersionId: first.versionId },
  });
  await control("/thread", {
    userId: reviewer.userId,
    artifactId: first.artifactId,
    versionId: second.versionId,
    path: "index.html",
    body: "Better now",
  });
  await signIn(context, owner);
  await page.goto(`${APP_ORIGIN}/`);

  const row = page.getByRole("row", { name: /Roadmap/ });
  await expect(row).toContainText("2 versions kept");
  await expect(row).toContainText("1 open thread");
  await expect(row).toContainText("Comments changed");
  await expect(page.getByText("Traffic is counted for your whole account")).toBeVisible();

  await page.goto(`${APP_ORIGIN}/artifacts/${first.artifactId}/history`);
  const section = page.getByRole("region", { name: "Conversations on earlier versions" });
  const summary = section.locator("summary", { hasText: "Version 1: 2 threads, 2 open" });
  await expect(summary).toBeVisible();
  await expect(section.getByText("Better now")).toHaveCount(0);
  await expect(section.getByText("Move the launch")).toBeHidden();
  // The disclosure opens from the keyboard and holds read-only threads.
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(section.getByText("Move the launch")).toBeVisible();
  await expect(section.getByText("Typo in the title")).toBeVisible();
  await expect(section.getByRole("button")).toHaveCount(0);
});
