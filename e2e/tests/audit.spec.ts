// The audit log (premium plan T10): an admin makes a few changes from the dashboard (a role, a
// removal, moving an artifact in) and reads them back on the Audit page, filters them, and an
// editor is not offered the page.

import type { Page } from "@playwright/test";
import { axeViolations } from "../src/axe.ts";
import { createUser, createWorkspace, expect, publish, signIn, test } from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const slug = () => `a-${crypto.randomUUID().slice(0, 8)}`;

async function open(page: Page, path: string, title: string) {
  await page.goto(`${APP_ORIGIN}${path}`);
  await page.getByRole("heading", { level: 1, name: title }).waitFor();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
}

async function choose(page: Page, combobox: string, option: string) {
  await page.getByRole("combobox", { name: combobox, exact: true }).click();
  await page
    .getByRole("listbox", { name: combobox, exact: true })
    .getByRole("option", { name: option })
    .click();
}

test("an admin reads back the changes they made, filters them, and an editor is not offered the page", async ({
  page,
  context,
  browser,
}) => {
  const admin = await createUser("Admin");
  const mia = await createUser("Mia");
  const ed = await createUser("Ed");
  const workspace = await createWorkspace({
    slug: slug(),
    name: "Audit team",
    admin,
    members: [
      { user: mia, role: "member" },
      { user: ed, role: "editor" },
    ],
  });
  const { artifactId } = await publish({
    ownerId: admin.userId,
    name: "Budget",
    files: { "index.html": "<!doctype html><title>Budget</title><h1>Budget</h1>" },
  });

  await signIn(context, admin);
  await open(page, `/members?workspace=${workspace.slug}`, "Members");
  await choose(page, "Role of Mia", "Editor");
  await expect(page.getByText("Mia is now Editor.")).toBeVisible();
  await page.getByRole("button", { name: "Remove Ed" }).click();
  await page
    .getByRole("dialog", { name: "Remove Ed from Audit team?" })
    .getByRole("button", { name: "Remove member" })
    .click();
  await expect(page.getByText("Ed was removed.")).toBeVisible();

  await open(page, `/artifacts/${artifactId}`, "Budget");
  await page
    .getByRole("region", { name: "Move to another space" })
    .getByRole("button", { name: "Move artifact" })
    .click();
  await page
    .getByRole("dialog", { name: "Move Budget to Audit team?" })
    .getByRole("button", { name: "Move", exact: true })
    .click();
  await expect(page.getByText("Budget moved to Audit team.")).toBeVisible();

  // The move has just switched the page to the workspace and the sidebar is being drawn again
  // for it: a click that lands while its links are replaced goes nowhere, so click until it took.
  const auditLink = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Audit log" });
  await expect(async () => {
    await auditLink.click();
    await expect(page).toHaveURL(`${APP_ORIGIN}/audit?workspace=${workspace.slug}`, {
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("heading", { level: 1, name: "Audit log" }).waitFor();
  const table = page.getByRole("table", { name: "Changes in this space, newest first" });
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(table.getByRole("row").nth(1)).toContainText("Moved it here from a personal space");
  await expect(table.getByRole("row").nth(1)).toContainText("Budget");
  await expect(table.getByRole("row").nth(2)).toContainText("Removed Removed member");
  await expect(table.getByRole("row").nth(3)).toContainText("Changed Mia from Member to Editor");
  await expect(table.getByRole("row").nth(4)).toContainText("Portifact operator");
  // Removed members are never named or shown by address.
  await expect(table).not.toContainText(ed.email);
  await expect(table).not.toContainText("@");

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    expect(await axeViolations(page), colorScheme).toEqual([]);
  }

  // The filters are buttons reached with the keyboard.
  await page.getByRole("combobox", { name: "Kind of change", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("listbox", { name: "Kind of change", exact: true })
    .getByRole("option", { name: "Publishing and lifecycle" })
    .click();
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("row").nth(1)).toContainText("Moved it here");

  const second = await browser.newContext();
  try {
    await signIn(second, mia);
    const editor = await second.newPage();
    await open(editor, `/?workspace=${workspace.slug}`, "Artifacts");
    await expect(
      editor.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Audit log" }),
    ).toHaveCount(0);
    await editor.goto(`${APP_ORIGIN}/audit?workspace=${workspace.slug}`);
    await expect(editor.getByText("Only admins can read the audit log")).toBeVisible();
    await expect(editor.getByRole("table")).toHaveCount(0);
  } finally {
    await second.close();
  }
});
