// "SSO required" end to end (decision 0021), against the stack's fake identity provider: an
// admin of an Enterprise workspace sets up single sign-on, signs in through it from the Policies
// page (the requirement is offered only then) and requires it, confirming who it binds; a member
// whose browser signed in another way gets one page whose action signs in through the provider
// and comes back to the workspace, which works again; and the admin's own browser that signed in
// another way is refused too.

import type { BrowserContext, Page } from "@playwright/test";
import { axeViolations } from "../src/axe.ts";
import {
  createUser,
  createWorkspace,
  expect,
  nextSsoIdentity,
  signIn,
  sql,
  test,
  type User,
} from "../src/fixtures.ts";
import { APP_ORIGIN, IDP_ISSUER } from "../src/hosts.ts";

test.skip(({ browserName }) => browserName === "webkit", "WebKit runs in CI");

async function axeInBothThemes(page: Page) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    expect(await axeViolations(page), colorScheme).toEqual([]);
  }
}

/** From the login page the blocked page or the Policies page opened: through the provider. */
async function continueWithSso(page: Page, user: User) {
  await nextSsoIdentity({ sub: `idp-${user.email}`, email: user.email, name: user.name });
  await expect(page.getByLabel("Email address")).toHaveValue(user.email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByRole("button", { name: "Continue with single sign-on" }).click();
}

/** Retries a click until it takes: the control appears only after data loads. */
async function clickUntil(page: Page, click: () => Promise<void>, done: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 5 && !(await done()); attempt++) {
    await click().catch(() => {});
    await page.waitForTimeout(200);
  }
}

test("an admin requires single sign-on and a member signs in through it to come back", async ({
  page,
  context,
  browser,
}) => {
  const domain = `corp-${crypto.randomUUID().slice(0, 8)}.com`;
  const admin = await createUser("Admin", domain);
  const member = await createUser("Member", domain);
  const workspace = await createWorkspace({
    slug: `req-${crypto.randomUUID().slice(0, 8)}`,
    name: "Corp",
    admin,
    members: [{ user: member, role: "editor" }],
  });
  await sql("update owner_plans set plan = 'enterprise' where owner_id = ?", [workspace.id]);
  await sql(
    "insert into workspace_domains (id, workspace_id, domain, token, state, created_at, expires_at, verified_at) values (?, ?, ?, ?, 'verified', ?, ?, ?)",
    [
      `wd_${crypto.randomUUID().replaceAll("-", "")}`,
      workspace.id,
      domain,
      "t".repeat(32),
      Date.now(),
      Date.now() + 86_400_000,
      Date.now(),
    ],
  );

  // The admin, signed in another way, sets the provider up on the Members page.
  await signIn(context, admin);
  await page.goto(`${APP_ORIGIN}/members?workspace=${workspace.slug}`);
  const setup = page.getByRole("region", { name: "Single sign-on" });
  await setup.getByRole("textbox", { name: "Issuer URL" }).fill(IDP_ISSUER);
  await setup.getByRole("textbox", { name: "Client ID" }).fill("portifact-client");
  await setup.getByLabel("Client secret").fill("fake-client-secret");
  await setup.getByRole("checkbox", { name: domain }).check();
  await setup.getByRole("button", { name: "Save", exact: true }).click();
  await expect(setup.getByText("On", { exact: true })).toBeVisible();

  // Requiring it is offered only after signing in through it, from this page and back.
  await page.goto(`${APP_ORIGIN}/policies?workspace=${workspace.slug}`);
  const panel = page.getByRole("group", { name: "Single sign-on" });
  await panel.waitFor();
  await expect(panel.getByRole("radio", { name: /Only through single sign-on/ })).toBeDisabled();
  await axeInBothThemes(page);
  await page.getByRole("link", { name: "Sign in with single sign-on" }).click();
  await continueWithSso(page, admin);
  await expect(page).toHaveURL(`${APP_ORIGIN}/policies?workspace=${workspace.slug}`);
  const only = page
    .getByRole("group", { name: "Single sign-on" })
    .getByRole("radio", { name: /Only through single sign-on/ });
  await clickUntil(
    page,
    () => only.check(),
    () => only.isChecked(),
  );
  await page.getByRole("button", { name: "Save policies" }).click();
  const dialog = page.getByRole("dialog", { name: "Require single sign-on?" });
  await expect(dialog).toContainText("will act on the workspace only through single sign-on");
  await expect(dialog).toContainText("Nobody is signed out");
  await axeInBothThemes(page);
  await dialog.getByRole("button", { name: "Require single sign-on" }).click();
  await expect(dialog).toBeHidden();
  const [row] = await sql<{ policy: string | null }>("select policy from workspaces where id = ?", [
    workspace.id,
  ]);
  expect(JSON.parse(row?.policy ?? "{}")).toMatchObject({ ssoRequired: true });

  // A member whose browser signed in another way is sent through the provider and comes back.
  const memberContext: BrowserContext = await browser.newContext();
  try {
    await signIn(memberContext, member);
    const memberPage = await memberContext.newPage();
    await memberPage.goto(`${APP_ORIGIN}/?workspace=${workspace.slug}`);
    await expect(
      memberPage.getByRole("heading", { name: "Sign in with single sign-on to continue" }),
    ).toBeVisible();
    await axeInBothThemes(memberPage);
    await memberPage.getByRole("link", { name: "Sign in with single sign-on" }).click();
    await continueWithSso(memberPage, member);
    await expect(memberPage).toHaveURL(`${APP_ORIGIN}/?workspace=${workspace.slug}`);
    await expect(memberPage.getByRole("heading", { level: 1, name: "Artifacts" })).toBeVisible();
    // The browser signed in through the provider; the earlier session was not ended.
    const methods = await sql<{ method: string | null }>(
      "select sign_in_method as method from sessions where user_id = ? order by created_at",
      [member.userId],
    );
    expect(methods.map((m) => m.method)).toContain(`sso:${await providerOf(workspace.id)}`);
    expect(methods.length).toBeGreaterThanOrEqual(2);
  } finally {
    await memberContext.close();
  }

  // The admin's own browser that signed in another way is refused too.
  const other = await browser.newContext();
  try {
    await signIn(other, admin);
    const otherPage = await other.newPage();
    await otherPage.goto(`${APP_ORIGIN}/?workspace=${workspace.slug}`);
    await expect(
      otherPage.getByRole("heading", { name: "Sign in with single sign-on to continue" }),
    ).toBeVisible();
  } finally {
    await other.close();
  }
});

async function providerOf(workspaceId: string): Promise<string> {
  const [row] = await sql<{ id: string }>("select id from workspace_sso where workspace_id = ?", [
    workspaceId,
  ]);
  return row?.id ?? "";
}
