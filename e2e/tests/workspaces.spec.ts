// Workspaces from the dashboard (premium plan T1): switching to a workspace and publishing into
// it, inviting someone who accepts from the email's link in a second browser signed in as them,
// the invitation page for another account and for someone signed out, changing a role and
// removing a member, a member's view, and moving an artifact into a workspace and back out.

import type { Browser, Page } from "@playwright/test";
import { axeViolations } from "../src/axe.ts";
import {
  createUser,
  createWorkspace,
  expect,
  lastEmail,
  publish,
  routeStorage,
  signIn,
  sql,
  test,
  type User,
} from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const slug = () => `t-${crypto.randomUUID().slice(0, 8)}`;

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

/** Invites `email` from the Members page and returns the link of the email it receives. */
async function invite(page: Page, workspace: string, email: string, role: string) {
  await open(page, `/members?workspace=${workspace}`, "Members");
  const form = page.getByRole("region", { name: "Invite someone" });
  await form.getByRole("textbox", { name: "Email" }).fill(email);
  await choose(page, "Role", role);
  await form.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText(`Invitation sent to ${email.toLowerCase()}.`)).toBeVisible();
  const sent = await lastEmail(email);
  const link = new RegExp(
    `${APP_ORIGIN.replaceAll(".", "\\.")}/invitations#token=[A-Za-z0-9_-]{43}`,
  ).exec(sent.text)?.[0];
  expect(link).toBeDefined();
  return link as string;
}

/** A second browser, signed in as `user` (or nobody), closed by the caller. */
async function secondBrowser(browser: Browser, user?: User) {
  const context = await browser.newContext();
  if (user) await signIn(context, user);
  return { context, page: await context.newPage() };
}

test("an admin switches to a workspace from the space menu and publishes into it", async ({
  page,
  context,
  browserName,
}) => {
  const admin = await createUser("Admin");
  const workspace = await createWorkspace({ slug: slug(), name: "Launch team", admin });
  await signIn(context, admin);
  await routeStorage(page);
  await open(page, "/", "Artifacts");

  await page.getByRole("button", { name: /^Space Personal/ }).click();
  await page.getByRole("link", { name: "Launch team Admin" }).click();
  await expect(page).toHaveURL(`${APP_ORIGIN}/?workspace=${workspace.slug}`);
  await expect(page.getByRole("button", { name: /^Space Launch team/ })).toBeVisible();
  await axeInBothThemes(page);

  // The choice survives a reload and stays on every link.
  await page.reload();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Publish" })
    .click();
  await expect(page).toHaveURL(`${APP_ORIGIN}/publish?workspace=${workspace.slug}`);
  await page.getByLabel("Choose files").setInputFiles({
    name: "index.html",
    mimeType: "text/html",
    buffer: Buffer.from("<!doctype html><title>Plan</title><h1>Plan</h1>"),
  });
  await page.getByRole("heading", { name: "Review before publishing" }).waitFor();
  await expect(
    page.getByText("The admins and editors of Launch team.", { exact: false }),
  ).toBeVisible();
  // The upload itself runs where the stand-in can receive it (see `routeStorage`): the review
  // above already shows where the artifact goes, which is what this test adds for a workspace.
  if (browserName === "webkit") return;
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Published version 1", { exact: true })).toBeVisible();
  const [row] = await sql<{ owner_id: string }>(
    "SELECT owner_id FROM artifacts WHERE owner_id = ? LIMIT 1",
    [workspace.id],
  );
  expect(row?.owner_id).toBe(workspace.id);
});

test("an invitee accepts from the email's link in another browser and shows up as a member", async ({
  page,
  context,
  browser,
}) => {
  const admin = await createUser("Admin");
  const invitee = await createUser("Invitee");
  const workspace = await createWorkspace({ slug: slug(), name: "Design crew", admin, seats: 5 });
  await signIn(context, admin);
  const link = await invite(page, workspace.slug, invitee.email, "Editor");
  await expect(page.getByRole("list", { name: "Pending invitations" })).toContainText(
    invitee.email,
  );
  await axeInBothThemes(page);

  const second = await secondBrowser(browser, invitee);
  try {
    await second.page.goto(link);
    // The token leaves the address bar before anything else reads it.
    await expect(second.page).toHaveURL(`${APP_ORIGIN}/invitations`);
    const card = second.page.getByRole("region", { name: "Design crew" });
    await expect(card).toContainText("Admin invited you to Design crew as Editor.");
    await second.page.emulateMedia({ reducedMotion: "reduce" });
    expect(await axeViolations(second.page)).toEqual([]);
    await card.getByRole("button", { name: "Accept the invitation to Design crew" }).click();
    await expect(second.page).toHaveURL(`${APP_ORIGIN}/?workspace=${workspace.slug}`);
    await expect(second.page.getByRole("button", { name: /^Space Design crew/ })).toBeVisible();
  } finally {
    await second.context.close();
  }

  await page.reload();
  const members = page.getByRole("list", { name: "Members of Design crew" });
  await expect(members).toContainText(invitee.email);
  await expect(page.getByText("No pending invitations.")).toBeVisible();
});

test("the invitation page names only the invited address to another account, and asks a visitor to sign in", async ({
  page,
  context,
  browser,
}) => {
  const admin = await createUser("Admin");
  const invitee = await createUser("Invitee");
  const other = await createUser("Other");
  const workspace = await createWorkspace({ slug: slug(), name: "Secret team", admin });
  await signIn(context, admin);
  const link = await invite(page, workspace.slug, invitee.email, "Member");

  const wrong = await secondBrowser(browser, other);
  try {
    await wrong.page.goto(link);
    const panel = wrong.page.getByRole("region", {
      name: "This invitation is for another address",
    });
    await expect(panel).toContainText(`It was sent to ${invitee.email.toLowerCase()}`);
    await expect(wrong.page.getByText("Secret team")).toHaveCount(0);
    await expect(wrong.page).toHaveURL(`${APP_ORIGIN}/invitations`);
    await wrong.page.emulateMedia({ reducedMotion: "reduce" });
    expect(await axeViolations(wrong.page)).toEqual([]);
  } finally {
    await wrong.context.close();
  }

  const visitor = await secondBrowser(browser);
  try {
    await visitor.page.goto(link);
    await visitor.page.getByRole("heading", { level: 1, name: "Workspace invitation" }).waitFor();
    await expect(visitor.page).toHaveURL(`${APP_ORIGIN}/invitations`);
    await expect(visitor.page.getByRole("link", { name: "Sign in to answer" })).toHaveAttribute(
      "href",
      "/login?next=%2Finvitations",
    );
    await visitor.page.emulateMedia({ reducedMotion: "reduce" });
    expect(await axeViolations(visitor.page)).toEqual([]);
  } finally {
    await visitor.context.close();
  }
});

test("an admin changes a role and removes a member, and a member sees the workspace read-only", async ({
  page,
  context,
  browser,
}) => {
  const admin = await createUser("Admin");
  const mia = await createUser("Mia");
  const ed = await createUser("Ed");
  const workspace = await createWorkspace({
    slug: slug(),
    name: "Ops",
    admin,
    members: [
      { user: mia, role: "member" },
      { user: ed, role: "editor" },
    ],
  });

  // The member's view: the list, publishing and the brand are not theirs; the members are.
  const member = await secondBrowser(browser, mia);
  try {
    await open(member.page, `/?workspace=${workspace.slug}`, "Artifacts");
    await expect(
      member.page.getByRole("navigation", { name: "Main" }).getByRole("link"),
    ).toHaveText(["Artifacts", "Apps", "Members", "Settings"]);
    await expect(member.page.getByText(/As a member of Ops, you read and comment/)).toBeVisible();
    await member.page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Members" })
      .click();
    await expect(member.page.getByRole("list", { name: "Members of Ops" })).toContainText(
      admin.email,
    );
    await expect(member.page.getByRole("combobox", { name: /^Role of/ })).toHaveCount(0);
    await expect(member.page.getByRole("region", { name: "Invite someone" })).toHaveCount(0);
    await axeInBothThemes(member.page);
  } finally {
    await member.context.close();
  }

  await signIn(context, admin);
  await open(page, `/members?workspace=${workspace.slug}`, "Members");
  await choose(page, "Role of Mia", "Editor");
  await expect(page.getByText("Mia is now Editor.")).toBeVisible();
  const [role] = await sql<{ role: string }>(
    "SELECT role FROM workspace_members WHERE user_id = ?",
    [mia.userId],
  );
  expect(role?.role).toBe("editor");

  await page.getByRole("button", { name: "Remove Ed" }).click();
  await page
    .getByRole("dialog", { name: "Remove Ed from Ops?" })
    .getByRole("button", { name: "Remove member" })
    .click();
  await expect(page.getByText("Ed was removed.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Members of Ops" })).not.toContainText(ed.email);
  // The only admin cannot leave, and the page says why.
  await expect(page.getByRole("button", { name: "Leave workspace" })).toBeDisabled();
  await expect(page.getByText(/The only admin: make another member an admin/)).toBeVisible();
});

test("an admin moves an artifact into a workspace and back out", async ({ page, context }) => {
  const admin = await createUser("Admin");
  const workspace = await createWorkspace({ slug: slug(), name: "Archive team", admin });
  const { artifactId } = await publish({
    ownerId: admin.userId,
    name: "Budget",
    files: { "index.html": "<!doctype html><title>Budget</title><h1>Budget</h1>" },
  });
  await signIn(context, admin);
  await open(page, `/artifacts/${artifactId}`, "Budget");
  const section = page.getByRole("region", { name: "Move to another space" });
  await expect(section.getByRole("combobox", { name: "Destination" })).toContainText(
    "Archive team (Admin)",
  );
  await section.getByRole("button", { name: "Move artifact" }).click();
  const dialog = page.getByRole("dialog", { name: "Move Budget to Archive team?" });
  await expect(dialog).toContainText("see who opened it, also before the move");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByText("Budget moved to Archive team.")).toBeVisible();
  await expect(page).toHaveURL(`${APP_ORIGIN}/artifacts/${artifactId}?workspace=${workspace.slug}`);
  const owner = async () =>
    (
      await sql<{ owner_id: string }>("SELECT owner_id FROM artifacts WHERE id = ?", [artifactId])
    )[0]?.owner_id;
  expect(await owner()).toBe(workspace.id);

  // Out again, as the workspace's admin.
  await expect(section.getByRole("combobox", { name: "Destination" })).toContainText("Personal");
  await section.getByRole("button", { name: "Move artifact" }).click();
  await page
    .getByRole("dialog", { name: "Move Budget to Personal?" })
    .getByRole("button", { name: "Move", exact: true })
    .click();
  await expect(page.getByText("Budget moved to Personal.")).toBeVisible();
  expect(await owner()).toBe(admin.userId);
});
