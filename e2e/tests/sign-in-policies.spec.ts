// A workspace's maximum session age end to end (decision 0021): an admin sets it on the Policies
// page and confirms who it binds; a member whose sign-in is older than it gets one page in the
// dashboard with the action that signs in again, signs in with an email code while the old
// session still exists, and comes back to the workspace, which works again.

import type { Page } from "@playwright/test";
import { axeViolations } from "../src/axe.ts";
import {
  createUser,
  createWorkspace,
  expect,
  lastEmail,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

test.skip(({ browserName }) => browserName === "webkit", "WebKit runs in CI");

async function axeInBothThemes(page: Page) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    expect(await axeViolations(page), colorScheme).toEqual([]);
  }
}

async function codeFor(email: string): Promise<string> {
  const code = /^\d{6}$/m.exec((await lastEmail(email)).text)?.[0];
  if (!code) throw new Error("no code in the email");
  return code;
}

test("an old sign-in is sent to sign in again and comes back to the workspace", async ({
  page,
  context,
  browser,
}) => {
  const admin = await createUser("Admin");
  const member = await createUser("Member");
  const workspace = await createWorkspace({
    slug: `age-${crypto.randomUUID().slice(0, 8)}`,
    name: "Short sessions",
    admin,
    members: [{ user: member, role: "editor" }],
  });
  await sql("update owner_plans set plan = 'enterprise' where owner_id = ?", [workspace.id]);
  await signIn(context, admin);

  await page.goto(`${APP_ORIGIN}/policies?workspace=${workspace.slug}`);
  const length = page.getByRole("group", { name: "Session length" });
  // The panel appears once the policies have loaded: wait for it rather than clicking at once.
  await length.waitFor();
  await length.getByRole("radio", { name: "Ask for a new sign-in" }).check();
  await page.getByRole("textbox", { name: "Hours after signing in" }).fill("8");
  await axeInBothThemes(page);
  await page.getByRole("button", { name: "Save policies" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Change how people sign in to this workspace?",
  });
  await expect(dialog.getByText("2 members will be bound")).toBeVisible();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(
      async () =>
        (
          await sql<{ policy: string | null }>("select policy from workspaces where id = ?", [
            workspace.id,
          ])
        )[0]?.policy ?? "",
    )
    .toContain('"sessionMaxHours":8');

  // The member signed in nine hours ago.
  const away = await browser.newContext();
  try {
    await signIn(away, member);
    await sql("update sessions set created_at = ? where user_id = ?", [
      Date.now() - 9 * 3_600_000,
      member.userId,
    ]);
    const memberPage = await away.newPage();
    await memberPage.goto(`${APP_ORIGIN}/?workspace=${workspace.slug}`);
    await expect(
      memberPage.getByRole("heading", { level: 1, name: "Sign in again to continue" }),
    ).toBeVisible();
    await axeInBothThemes(memberPage);
    await memberPage.getByRole("link", { name: "Sign in again" }).click();
    await expect(memberPage).toHaveURL(/\/login\?reauth=session_age/);
    await expect(memberPage.getByText(/asks for a new sign-in after a while/)).toBeVisible();
    await memberPage.getByLabel("Email address").fill(member.email);
    await memberPage.getByRole("button", { name: "Email me a code" }).click();
    await memberPage.getByLabel("6-digit code").fill(await codeFor(member.email));
    await memberPage.getByRole("button", { name: "Sign in", exact: true }).click();
    // Back where the member was, with a new session: the workspace works again.
    await expect(memberPage).toHaveURL(new RegExp(`\\?workspace=${workspace.slug}$`));
    await expect(memberPage.getByRole("heading", { level: 1, name: "Artifacts" })).toBeVisible();
    // The old session was not ended by the policy.
    const sessions = await sql<{ n: number }>(
      "select count(*) as n from sessions where user_id = ?",
      [member.userId],
    );
    expect(sessions[0]?.n).toBeGreaterThanOrEqual(2);
  } finally {
    await away.close();
  }
});
