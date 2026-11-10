// The dashboard's layout in a real browser: whole rows and option cards take a press anywhere on
// them, the artifact page is grouped by task with each group saved where it is, and phones get
// a layout of their own (stacked rows, filters in a sheet, nothing scrolls sideways).

import type { Locator, Page } from "@playwright/test";
import { axeViolations } from "../src/axe.ts";
import { createUser, expect, publish, signIn, test } from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const PAGE = { "index.html": "<!doctype html><title>Page</title><p>Hello</p>" };

/**
 * A real press at the middle of `target`, wherever the pointer lands. Playwright's own click
 * refuses when another element (here the row's stretched link or a card's label) takes the
 * press, which is exactly what these tests prove.
 */
async function pressOn(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("The target is not visible");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Whether the page scrolls sideways, which a phone layout must never do. */
const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

test("a press anywhere on a row opens the artifact, and its own buttons keep working", async ({
  page,
  context,
}) => {
  const owner = await createUser("Rower");
  const { artifactId } = await publish({ ownerId: owner.userId, name: "Row plan", files: PAGE });
  await signIn(context, owner);
  await page.goto(`${APP_ORIGIN}/`);
  const row = page.getByRole("row").filter({ hasText: "Row plan" });
  // The review button is above the row's link: hovering it shows its own title.
  await expect(row.getByRole("link", { name: "Review and comment on Row plan" })).toHaveAttribute(
    "href",
    `/view/${artifactId}`,
  );
  // A press on the activity cell, far from the name, opens the artifact page.
  await pressOn(page, row.getByText(/^Updated /));
  await expect(page.getByRole("heading", { level: 1, name: "Row plan" })).toBeVisible();
  await expect(page).toHaveURL(`${APP_ORIGIN}/artifacts/${artifactId}`);
});

test("option cards choose on a press anywhere, and each settings group saves on its own", async ({
  page,
  context,
}) => {
  const owner = await createUser("Carder");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    name: "Card plan",
    files: PAGE,
    annotations: "off",
  });
  await signIn(context, owner);
  await page.goto(`${APP_ORIGIN}/artifacts/${artifactId}`);
  const nav = page.getByRole("navigation", { name: "Artifact sections" });
  await expect(nav.getByRole("link")).toHaveText([
    "Overview",
    "Sharing",
    "Comments",
    "Reviews",
    "Activity",
    "Space",
    "Danger zone",
  ]);

  const access = page.getByRole("region", { name: "Access" });
  const signedIn = access.getByRole("radio", { name: "Anyone signed in to Portifact" });
  // The description, not the radio or its label.
  await pressOn(
    page,
    access.getByText("Anyone with the link who signs in to Portifact, with any account."),
  );
  await expect(signedIn).toBeChecked();
  await expect(access.getByText("Unsaved changes")).toBeVisible();
  await access.getByRole("button", { name: "Save access" }).click();
  await expect(page.getByText(/Access saved/).first()).toBeVisible();
  await expect(access.getByText("Unsaved changes")).toBeHidden();

  // Comments turn on from the page, from their own group.
  await nav.getByRole("link", { name: "Comments" }).click();
  const comments = page.getByRole("region", { name: "Comment settings" });
  await pressOn(
    page,
    comments.getByText("People who can open the artifact can comment and reply."),
  );
  await expect(comments.getByRole("radio", { name: "Open", exact: true })).toBeChecked();
  await comments.getByRole("button", { name: "Save comment settings" }).click();
  await expect(page.getByText("Comment settings saved.").first()).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole("region", { name: "Comment settings" })
      .getByRole("radio", { name: "Open", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("region", { name: "Access" }).getByRole("radio", {
      name: "Anyone signed in to Portifact",
    }),
  ).toBeChecked();

  // The publish type cards take a press on their description too.
  await page.goto(`${APP_ORIGIN}/publish`);
  await pressOn(page, page.getByText("A Markdown document, rendered by Portifact."));
  await expect(page.getByRole("radio", { name: "Markdown" })).toBeChecked();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 760 } });

  test("the list stacks its rows and keeps the filters in a sheet, without sideways scrolling", async ({
    page,
    context,
  }) => {
    const owner = await createUser("Phoner");
    await publish({ ownerId: owner.userId, name: "Phone plan", files: PAGE });
    const { artifactId } = await publish({
      ownerId: owner.userId,
      type: "markdown",
      name: "Phone notes with a rather long name that has to wrap",
      files: { "index.md": "# Notes" },
    });
    await signIn(context, owner);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${APP_ORIGIN}/`);
    await expect(page.getByRole("row").filter({ hasText: "Phone plan" })).toBeVisible();
    expect(await scrollsSideways(page)).toBe(false);
    await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Type" })).toHaveCount(0);
    expect(await axeViolations(page)).toEqual([]);

    await page.getByRole("button", { name: "Filters" }).click();
    const sheet = page.getByRole("dialog", { name: "Filter artifacts" });
    await sheet.getByRole("combobox", { name: "Type" }).click();
    await page.getByRole("option", { name: "Markdown" }).click();
    await expect(page).toHaveURL(`${APP_ORIGIN}/?type=markdown`);
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: "Filters 1 on" })).toBeFocused();
    await expect(page.getByRole("row")).toHaveCount(2);

    // A press on the stacked card opens the artifact.
    await pressOn(
      page,
      page
        .getByRole("row")
        .nth(1)
        .getByText(/^Updated /),
    );
    await expect(page).toHaveURL(`${APP_ORIGIN}/artifacts/${artifactId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(/^Loading/)).toHaveCount(0);
    expect(await scrollsSideways(page)).toBe(false);
    expect(await axeViolations(page)).toEqual([]);
  });
});

test("on a laptop screen the list fits without scrolling sideways, actions included", async ({
  page,
  context,
}) => {
  const owner = await createUser("Laptop");
  await publish({ ownerId: owner.userId, name: "Quarterly planning notes", files: PAGE });
  await signIn(context, owner);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${APP_ORIGIN}/`);
  const row = page.getByRole("row").filter({ hasText: "Quarterly planning notes" });
  const review = row.getByRole("link", { name: "Review and comment on Quarterly planning notes" });
  await expect(review).toBeVisible();
  // The table's frame scrolls sideways when the columns do not fit, hiding the row's actions.
  const overflow = await page.getByRole("table").evaluate((table) => {
    const frame = table.parentElement as HTMLElement;
    return frame.scrollWidth - frame.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
});

test("on a very wide screen the artifact list reaches the right edge, with no cap on the page", async ({
  page,
  context,
}) => {
  const owner = await createUser("Ultrawide");
  await publish({ ownerId: owner.userId, name: "Ultrawide notes", files: PAGE });
  await signIn(context, owner);
  await page.setViewportSize({ width: 2560, height: 1000 });
  await page.goto(`${APP_ORIGIN}/`);
  await expect(page.getByRole("row").filter({ hasText: "Ultrawide notes" })).toBeVisible();
  // Only the page's own padding separates the table from the window's right edge.
  const table = await page.getByRole("table").boundingBox();
  const right = (table?.x ?? 0) + (table?.width ?? 0);
  expect(2560 - right).toBeLessThanOrEqual(48);
  expect(await scrollsSideways(page)).toBe(false);
});

test("wide screens use the room: the page starts at the sidebar and the section guide sits at the end", async ({
  page,
  context,
}) => {
  const owner = await createUser("Wide");
  const { artifactId } = await publish({ ownerId: owner.userId, name: "Wide plan", files: PAGE });
  await signIn(context, owner);
  await page.setViewportSize({ width: 1900, height: 900 });
  await page.goto(`${APP_ORIGIN}/artifacts/${artifactId}`);
  await expect(page.getByText(/^Loading/)).toHaveCount(0);

  // No centered column between two empty gutters: the title starts next to the sidebar, and the
  // content is far wider than the old reading column.
  const sidebar = await page.getByRole("banner").boundingBox();
  const title = await page.getByRole("heading", { level: 1, name: "Wide plan" }).boundingBox();
  expect((title?.x ?? 0) - (sidebar?.width ?? 0)).toBeLessThanOrEqual(48);
  const overview = await page.getByRole("region", { name: "Overview" }).boundingBox();
  expect(overview?.width ?? 0).toBeGreaterThan(1000);

  const nav = page.getByRole("navigation", { name: "Artifact sections" });
  await expect(nav.getByText("On this page")).toBeVisible();
  const guide = await nav.boundingBox();
  expect(guide?.x ?? 0).toBeGreaterThan((overview?.x ?? 0) + (overview?.width ?? 0));
  await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "true");

  // Following a link scrolls there, focuses the section and the guide follows; at the end of
  // the page the last section is the current one.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await nav.getByRole("link", { name: "Activity" }).click();
  await expect(page.getByRole("region", { name: "Activity" })).toBeFocused();
  await expect(page).toHaveURL(`${APP_ORIGIN}/artifacts/${artifactId}#activity`);
  await expect(nav.getByRole("link", { name: "Activity" })).toHaveAttribute("aria-current", "true");
  // The guide stays in view while the page scrolls.
  expect((await nav.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
  // Scrolling with the keyboard hands the guide back to the scroll spy.
  await page.keyboard.press("Home");
  await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("End");
  // WebKit's End does not always reach the bottom when a section has focus; a wheel scroll over
  // the content finishes the trip the way a person would.
  await page.mouse.move(900, 450);
  await page.mouse.wheel(0, 20_000);
  await expect(nav.getByRole("link", { name: "Danger zone" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(await scrollsSideways(page)).toBe(false);
  expect(await axeViolations(page)).toEqual([]);
});
