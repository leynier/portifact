// Single sign-on with OpenID Connect for a workspace (premium plan E1, decision 0016), end to end
// against the stack's fake identity provider (worker/sso.ts): an admin of an Enterprise workspace
// with a verified email domain sets the provider up on the Members page, then a new person at the
// domain signs in from the login page through the provider, accepting the terms by continuing,
// and lands in the dashboard as a member of the workspace.

import { TERMS_VERSION } from "@portifact/contracts";
import { axeViolations } from "../src/axe.ts";
import {
  createUser,
  createWorkspace,
  expect,
  nextSsoIdentity,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN, IDP_ISSUER } from "../src/hosts.ts";

test("an admin sets up single sign-on and a new person joins the workspace through it", async ({
  page,
  context,
  browser,
}) => {
  const domain = `corp-${crypto.randomUUID().slice(0, 8)}.com`;
  const admin = await createUser("Admin");
  const workspace = await createWorkspace({
    slug: `s-${crypto.randomUUID().slice(0, 8)}`,
    name: "Corp",
    admin,
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

  await signIn(context, admin);
  await page.goto(`${APP_ORIGIN}/members?workspace=${workspace.slug}`);
  const sso = page.getByRole("region", { name: "Single sign-on" });
  await expect(sso.getByText("Not set up")).toBeVisible();
  await sso.getByRole("textbox", { name: "Issuer URL" }).fill(IDP_ISSUER);
  await sso.getByRole("button", { name: "Check the issuer" }).click();
  await expect(sso.getByText("Discovery works", { exact: true })).toBeVisible();
  await sso.getByRole("textbox", { name: "Client ID" }).fill("portifact-client");
  await sso.getByLabel("Client secret").fill("fake-client-secret");
  await sso.getByRole("checkbox", { name: domain }).check();
  await sso.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sso.getByText("On", { exact: true })).toBeVisible();
  await expect(sso.getByText(`${APP_ORIGIN}/api/auth/sso/callback/sso_`)).toBeVisible();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    expect(await axeViolations(page), colorScheme).toEqual([]);
  }

  // A new person at the domain, in their own browser, with no account yet.
  const email = `grace-${crypto.randomUUID().slice(0, 8)}@${domain}`;
  await nextSsoIdentity({ sub: `idp-${email}`, email, name: "Grace" });
  const guest = await browser.newContext();
  try {
    const login = await guest.newPage();
    await login.goto(`${APP_ORIGIN}/login`);
    await login.getByLabel("Email address").fill(email);
    await login.getByRole("button", { name: "Email me a code" }).click();
    await expect(
      login.getByRole("heading", { name: "Your organization uses single sign-on" }),
    ).toBeFocused();
    const notice = login.locator("#terms-notice-sso");
    await expect(notice).toContainText(
      "By continuing with Google, GitHub, an email code or single sign-on",
    );
    await expect(login.locator("#terms-notice")).toBeHidden();
    for (const colorScheme of ["light", "dark"] as const) {
      await login.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      expect(await axeViolations(login), colorScheme).toEqual([]);
    }
    await login.getByRole("button", { name: "Continue with single sign-on" }).click();
    await expect(login.getByRole("heading", { level: 1, name: "Artifacts" })).toBeVisible();
    expect(new URL(login.url()).origin).toBe(APP_ORIGIN);

    const [account] = await sql<{ id: string; terms_version: string | null }>(
      "select id, terms_version from users where email = ?",
      [email],
    );
    expect(account?.terms_version).toBe(TERMS_VERSION);
    const [membership] = await sql<{ role: string }>(
      "select role from workspace_members where workspace_id = ? and user_id = ?",
      [workspace.id, account?.id ?? ""],
    );
    expect(membership?.role).toBe("member");
  } finally {
    await guest.close();
  }
});
