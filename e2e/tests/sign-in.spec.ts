// Sign-in in a real browser: the email code from the keyboard, the implicit acceptance of the
// terms that every method records (docs/legal.md), the human check of new accounts that stays
// invisible unless Cloudflare asks for an interaction and fails closed without it (docs/security.md,
// "Human check"), and accounts on older terms sent to review them. Turnstile and the email
// provider are faked at their boundaries (src/turnstile-fake.ts, worker/index.ts).

import type { Page } from "@playwright/test";
import { TERMS_VERSION } from "@portifact/contracts";
import { axeViolations } from "../src/axe.ts";
import { createUser, expect, lastEmail, signIn, sql, test } from "../src/fixtures.ts";
import { APP_HOST, APP_ORIGIN } from "../src/hosts.ts";
import { TURNSTILE_MODE_COOKIE } from "../src/turnstile-fake.ts";

const uniqueEmail = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}@example.test`;

async function codeFor(email: string): Promise<string> {
  const message = await lastEmail(email);
  expect(message.subject).toBe("Your Portifact sign-in code");
  const code = /^\d{6}$/m.exec(message.text)?.[0];
  if (!code) throw new Error("no code in the email");
  expect(message.html).toContain(`>${code}</p>`);
  return code;
}

async function accountOf(email: string) {
  const [row] = await sql<{ terms_version: string | null; terms_accepted_at: number | null }>(
    "SELECT terms_version, terms_accepted_at FROM users WHERE email = ?",
    [email],
  );
  return row;
}

async function challenge(page: Page, mode: "interactive" | "fail") {
  await page
    .context()
    .addCookies([{ name: TURNSTILE_MODE_COOKIE, value: mode, domain: APP_HOST, path: "/" }]);
}

/** Types the address, asks for a code and waits for the code step, from the keyboard alone. */
async function requestCode(page: Page, email: string) {
  await page.getByLabel("Email address").focus();
  await page.keyboard.type(email);
  await page.keyboard.press("Enter");
}

test("a new account signs up with an email code, accepting the terms by continuing", async ({
  page,
}) => {
  const email = uniqueEmail("new");
  await page.goto(`${APP_ORIGIN}/login`);
  await expect(page.getByRole("heading", { name: "Sign in to Portifact" })).toBeVisible();

  // The notice sits above every method, with the three documents linked, and no checkbox.
  const notice = page.locator("#terms-notice");
  await expect(notice).toContainText("By continuing with Google, GitHub or an email code");
  await expect(notice.getByRole("link", { name: "Terms of Service" })).toBeVisible();
  await expect(notice.getByRole("link", { name: "Acceptable Use Policy" })).toBeVisible();
  await expect(notice.getByRole("link", { name: "Privacy Policy" })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  // The check runs invisibly: nothing about it on screen.
  await expect(page.getByText("One more step")).toBeHidden();

  await requestCode(page, email);
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByLabel("6-digit code")).toBeFocused();
  await expect(page.getByRole("button", { name: /Send a new code in \d+s/ })).toBeDisabled();

  await page.keyboard.type(await codeFor(email));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Artifacts" })).toBeVisible();

  const account = await accountOf(email);
  expect(account?.terms_version).toBe(TERMS_VERSION);
  expect(account?.terms_accepted_at).not.toBeNull();
  const cookies = (await page.context().cookies(APP_ORIGIN)).map((cookie) => cookie.name);
  expect(cookies).not.toContain("__Host-pf_terms");
  expect(cookies).not.toContain("__Host-pf_human");
});

test("shows the human check below the methods only when it needs an interaction", async ({
  page,
}) => {
  const email = uniqueEmail("interactive");
  await challenge(page, "interactive");
  await page.goto(`${APP_ORIGIN}/login`);
  const copy = page.getByText("One more step: confirm you are human");
  await expect(copy).toBeVisible();
  const widget = page.getByRole("checkbox", { name: "Verify you are human" });
  await expect(widget).toBeVisible();

  await requestCode(page, email);
  // The code waits for the check; solving it lets the sign-in continue by itself.
  await expect(page.getByRole("button", { name: "Email me a code" })).toBeDisabled();
  // A click, not check(): the solved challenge is removed at once, so its state cannot be read back.
  await widget.click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(copy).toBeHidden();

  await page.getByLabel("6-digit code").fill(await codeFor(email));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Artifacts" })).toBeVisible();
  expect((await accountOf(email))?.terms_version).toBe(TERMS_VERSION);
});

test("refuses a new account whose human check failed, and lets an existing one in", async ({
  page,
}) => {
  await challenge(page, "fail");
  const email = uniqueEmail("unchecked");
  await page.goto(`${APP_ORIGIN}/login`);
  await requestCode(page, email);
  await page.getByLabel("6-digit code").fill(await codeFor(email));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("New accounts need a quick check");
  expect(await accountOf(email)).toBeUndefined();

  // Existing accounts never need the check.
  const existing = await createUser("Existing");
  await page.getByRole("button", { name: "Use a different email" }).click();
  await page.getByLabel("Email address").fill(existing.email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("6-digit code").fill(await codeFor(existing.email));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Artifacts" })).toBeVisible();
});

test("sends a session on older terms to review them, and records the acceptance", async ({
  page,
  context,
}) => {
  const user = await createUser("Older");
  await sql("UPDATE users SET terms_version = ? WHERE id = ?", ["2000-01-01", user.userId]);
  await signIn(context, user);
  await page.goto(`${APP_ORIGIN}/`);
  await expect(page).toHaveURL(/\/login\?next=%2F$/);
  await expect(page.getByRole("heading", { name: "Review the terms to continue" })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.locator("#terms-update-notice")).toContainText(
    "By selecting Agree and continue",
  );

  await page.getByRole("button", { name: "Agree and continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Artifacts" })).toBeVisible();
  expect((await accountOf(user.email))?.terms_version).toBe(TERMS_VERSION);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the sign-in page has no axe violations in the ${colorScheme} theme`, async ({ page }) => {
    // Reduced motion, so the card's entrance animation never fades the text axe measures.
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto(`${APP_ORIGIN}/login`);
    await expect(page.getByRole("heading", { name: "Sign in to Portifact" })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);

    await page.getByRole("button", { name: "Email me a code" }).click();
    await expect(page.getByText("Enter your email address.")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
}
