// The plans (premium plan L5) in a real browser under the real CSP: the landing's pricing
// section, drawn at build time from PLANS, and the dashboard's Plan page with the signed-in
// account's plan from the usage endpoint. There is no checkout: paid plans are requested by
// email, so the only links out are `mailto:` links.
import { PLANS, planRequestHref } from "@portifact/contracts/plans";
import { axeViolations } from "../src/axe.ts";
import { createUser, expect, grantPlan, signIn, test } from "../src/fixtures.ts";
import { APP_ORIGIN, SITE_ORIGIN } from "../src/hosts.ts";

test("the landing shows the plans from its navigation, accessible in both themes", async ({
  page,
}) => {
  // A fade-in otherwise fails contrast in WebKit while it runs.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${SITE_ORIGIN}/`);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Plans", exact: true })
    .click();
  await expect(page).toHaveURL(/#plans$/);
  const section = page.locator("section#plans");
  await expect(section.getByRole("heading", { level: 2 })).toBeVisible();
  await expect(section.getByRole("article")).toHaveCount(4);
  const pro = section.getByRole("article", { name: "Pro" });
  await expect(pro).toContainText("$2");
  await expect(pro.getByRole("link", { name: "Request access to the Pro plan" })).toHaveAttribute(
    "href",
    planRequestHref("pro"),
  );
  // Free goes to sign-in, the same destination as the landing's own "Sign in".
  const signInHref = await page
    .locator("header")
    .getByRole("link", { name: "Sign in" })
    .getAttribute("href");
  expect(signInHref).toBeTruthy();
  await expect(section.getByRole("article", { name: "Free" }).getByRole("link")).toHaveAttribute(
    "href",
    signInHref ?? "",
  );
  const table = section.getByRole("table", { name: "Limits of each plan" });
  await expect(table.getByRole("rowheader", { name: "Active artifacts" })).toBeVisible();
  await expect(table.locator('td[data-plan="pro"][data-limit="activeArtifacts"]')).toHaveText(
    PLANS.pro.limits.activeArtifacts.toLocaleString("en"),
  );
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    expect(await axeViolations(page), scheme).toEqual([]);
  }
});

test("the landing's plans are prerendered in every language", async ({ page }) => {
  await page.goto(`${SITE_ORIGIN}/es/`);
  const section = page.locator("section#plans");
  await expect(
    section.getByRole("link", { name: "Solicitar acceso al plan Team" }),
  ).toHaveAttribute("href", planRequestHref("team"));
  await expect(section.getByRole("table", { name: "Límites de cada plan" })).toBeVisible();
});

test("the dashboard's Plan page shows the account's plan and requests the others by email", async ({
  page,
  context,
}) => {
  const owner = await createUser("Planner");
  await grantPlan(owner.userId, "pro");
  await signIn(context, owner);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${APP_ORIGIN}/`);
  await page
    .getByRole("navigation", { name: "Main" })
    .first()
    .getByRole("link", { name: "Plan", exact: true })
    .click();
  await expect(page).toHaveURL(`${APP_ORIGIN}/plan`);
  await expect(page.getByRole("heading", { level: 1, name: "Plan" })).toBeVisible();
  const current = page.getByRole("region", { name: "Current plan" });
  await expect(current.getByRole("definition").first()).toHaveText("Pro");
  const all = page.getByRole("region", { name: "All plans" });
  await expect(all.getByRole("article", { name: "Pro" })).toContainText("Current plan");
  // The current plan is not requested again; the other paid plans are, by email.
  await expect(all.getByRole("link", { name: /^Request access/ })).toHaveCount(2);
  await expect(all.getByRole("link", { name: "Request access to the Team plan" })).toHaveAttribute(
    "href",
    planRequestHref("team"),
  );
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    expect(await axeViolations(page), scheme).toEqual([]);
  }
});
