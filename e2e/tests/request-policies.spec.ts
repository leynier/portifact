// A workspace's network allowlist end to end (decision 0020): an admin limits people to the
// office's networks on the Policies page, the dashboard confirms who it binds, and a member in a
// second browser outside those networks gets one clear page for the workspace in the dashboard
// and is refused on the artifact origin, with nothing of the artifact shown. The client address
// is set at the stack's edge (`x-e2e-client-ip`, e2e/worker/index.ts), never in product code.

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

const OFFICE = "192.0.2.10";
const HOME = "198.51.100.20";
const CLIENT_IP = "x-e2e-client-ip";

async function axeInBothThemes(page: Page) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    expect(await axeViolations(page), colorScheme).toEqual([]);
  }
}

async function browserAt(browser: Browser, user: User, ip: string) {
  const context = await browser.newContext({ extraHTTPHeaders: { [CLIENT_IP]: ip } });
  await signIn(context, user);
  return { context, page: await context.newPage() };
}

test("an admin limits people to the office: a member elsewhere is refused in the dashboard and on the artifact", async ({
  page,
  context,
  browser,
}) => {
  await context.setExtraHTTPHeaders({ [CLIENT_IP]: OFFICE });
  const admin = await createUser("Admin");
  const member = await createUser("Member");
  const workspace = await createWorkspace({
    slug: `net-${crypto.randomUUID().slice(0, 8)}`,
    name: "Office team",
    admin,
    members: [{ user: member, role: "editor" }],
  });
  await sql("update owner_plans set plan = 'enterprise' where owner_id = ?", [workspace.id]);
  const artifact = await publish({
    ownerId: admin.userId,
    targetOwnerId: workspace.id,
    name: "Office plan",
    files: { "index.html": "<!doctype html><title>Office plan</title><h1>Office plan</h1>" },
  });
  await sql("update artifacts set access_mode = 'workspace' where id = ?", [artifact.artifactId]);
  await signIn(context, admin);

  await page.goto(`${APP_ORIGIN}/policies?workspace=${workspace.slug}`);
  await page.getByRole("heading", { level: 1, name: "Policies" }).waitFor();
  const people = page.getByRole("group", { name: "Networks for people" });
  await people.getByRole("radio", { name: "Only these networks" }).check();
  await expect(
    page.getByText(`Your current address is ${OFFICE}.`, { exact: false }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Allowed IP addresses and ranges" }).fill("192.0.2.0/24");
  await axeInBothThemes(page);
  await page.getByRole("button", { name: "Save policies" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Limit the networks that reach this workspace?",
  });
  await expect(
    dialog.getByText("2 members will reach the workspace only from the allowed networks"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Limit networks" }).click();
  const stored = async () =>
    (
      await sql<{ policy: string | null }>("select policy from workspaces where id = ?", [
        workspace.id,
      ])
    )[0]?.policy ?? "";
  await expect.poll(stored).toContain('"ipAllowlist":["192.0.2.0/24"]');

  // The member at home: one clear page for the workspace, their personal space still works.
  const away = await browserAt(browser, member, HOME);
  try {
    await away.page.goto(`${APP_ORIGIN}/?workspace=${workspace.slug}`);
    await expect(
      away.page.getByRole("heading", { level: 1, name: "Not reachable from this network" }),
    ).toBeVisible();
    await axeInBothThemes(away.page);
    await away.page.getByRole("link", { name: "Go to your personal space" }).click();
    await expect(away.page.getByRole("heading", { level: 1, name: "Artifacts" })).toBeVisible();

    // On the artifact origin: sent to sign in, where the app says why, naming nothing.
    await away.page.goto(`${artifactOrigin(artifact.artifactId)}/`);
    await expect(away.page).toHaveURL(/\/login\?error=network_refused/);
    await expect(away.page.getByText(/approved networks/).first()).toBeVisible();
    await expect(away.page.getByText("Office plan")).toHaveCount(0);
  } finally {
    await away.context.close();
  }

  // The same member from the office reads it.
  const inside = await browserAt(browser, member, OFFICE);
  try {
    await inside.page.goto(`${artifactOrigin(artifact.artifactId)}/`);
    await expect(inside.page.getByRole("heading", { name: "Office plan" })).toBeVisible();
  } finally {
    await inside.context.close();
  }
});
