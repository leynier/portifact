// Groups of a workspace (premium plan T3, decision 0014): an admin creates a group on the Groups
// page and adds a member to it, then lists it on a restricted artifact from its sharing settings;
// the group's member opens the artifact in their own browser and another member cannot, and once
// the admin takes the member out of the group, a new visit is refused.

import type { Browser, Page } from "@playwright/test";
import { axeViolations } from "../src/axe.ts";
import {
  createUser,
  createWorkspace,
  expect,
  publish,
  signIn,
  sql,
  test,
  type User,
} from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin } from "../src/hosts.ts";

const PAGE = "<!doctype html><title>Design review</title><h1>Design review</h1>";

async function open(page: Page, path: string, title: string) {
  await page.goto(`${APP_ORIGIN}${path}`);
  await page.getByRole("heading", { level: 1, name: title }).waitFor();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
}

async function axeInBothThemes(page: Page) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    expect(await axeViolations(page), colorScheme).toEqual([]);
  }
}

async function choose(page: Page, combobox: string, option: string) {
  await page.getByRole("combobox", { name: combobox, exact: true }).click();
  await page
    .getByRole("listbox", { name: combobox, exact: true })
    .getByRole("option", { name: option })
    .click();
}

/** Opens the artifact in a fresh browser signed in as `user`; answers whether it was served. */
async function opens(browser: Browser, user: User, artifactId: string): Promise<boolean> {
  const context = await browser.newContext();
  try {
    await signIn(context, user);
    const page = await context.newPage();
    await page.goto(`${artifactOrigin(artifactId)}/`);
    const served = page.getByRole("heading", { name: "Design review" });
    const refused = page.getByText("cannot be opened with this account");
    await expect(served.or(refused)).toBeVisible();
    return await served.isVisible();
  } finally {
    await context.close();
  }
}

test("an admin lists a group on a restricted artifact, its member opens it, and removal stops it", async ({
  page,
  context,
  browser,
}) => {
  const admin = await createUser("Admin");
  const designer = await createUser("Designer");
  const other = await createUser("Other");
  const workspace = await createWorkspace({
    slug: `g-${crypto.randomUUID().slice(0, 8)}`,
    name: "Acme",
    admin,
    members: [
      { user: designer, role: "member" },
      { user: other, role: "member" },
    ],
  });
  await signIn(context, admin);

  await open(page, `/groups?workspace=${workspace.slug}`, "Groups");
  await expect(page.getByText("No groups yet")).toBeVisible();
  await page.getByRole("textbox", { name: "Name" }).fill("Design");
  await page.getByRole("button", { name: "Create group" }).click();
  const card = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Design" }) });
  await expect(card.getByText("0 members")).toBeVisible();
  await card.getByRole("button", { name: "Members" }).click();
  await choose(page, "Add a member to Design", `Designer (${designer.email})`);
  await card.getByRole("button", { name: "Add", exact: true }).click();
  await expect(card.getByRole("list", { name: "Members of Design" })).toContainText("Designer");
  await axeInBothThemes(page);

  const { artifactId } = await publish({
    ownerId: admin.userId,
    targetOwnerId: workspace.id,
    name: "Design review",
    files: { "index.html": PAGE },
    bar: false,
  });
  await open(page, `/artifacts/${artifactId}?workspace=${workspace.slug}`, "Design review");
  const groups = page.getByRole("region", { name: "Groups" });
  await expect(groups.getByText("No groups added.")).toBeVisible();
  await choose(page, "Add a group", "Design (1 member)");
  await groups.getByRole("button", { name: "Add group" }).click();
  await expect(
    groups.getByRole("list", { name: "Groups that can open this artifact" }),
  ).toContainText("Design");
  await expect
    .poll(
      async () =>
        (
          await sql<{ n: number }>(
            "SELECT count(*) AS n FROM artifact_groups WHERE artifact_id = ?",
            [artifactId],
          )
        )[0]?.n,
    )
    .toBe(1);
  await axeInBothThemes(page);

  expect(await opens(browser, designer, artifactId)).toBe(true);
  expect(await opens(browser, other, artifactId)).toBe(false);

  // Out of the group: a new visit is refused at once (open sessions within their claims' minute).
  await open(page, `/groups?workspace=${workspace.slug}`, "Groups");
  await card.getByRole("button", { name: "Members" }).click();
  await card.getByRole("button", { name: "Remove Designer from Design" }).click();
  await expect(card.getByText("Nobody is in this group yet.")).toBeVisible();
  expect(await opens(browser, designer, artifactId)).toBe(false);
});
