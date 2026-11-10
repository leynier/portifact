// Sharing with a workspace or its email domains (premium plan T2, decision 0010): an admin
// verifies an email domain from the Members page through the stack's fake DNS and shares an
// artifact with it from the access settings; a member and an account at the domain open it in
// their own browsers, and an outsider is refused. In the workspace mode only members get in.

import type { Browser, Page } from "@playwright/test";
import { axeViolations } from "../src/axe.ts";
import {
  createUser,
  createWorkspace,
  expect,
  fakeDomains,
  publish,
  signIn,
  sql,
  test,
  type User,
} from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin } from "../src/hosts.ts";

const PAGE = "<!doctype html><title>Team plan</title><h1>Team plan</h1>";
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

/** Opens the artifact in a fresh browser signed in as `user`; answers whether it was served. */
async function opens(browser: Browser, user: User, artifactId: string): Promise<boolean> {
  const context = await browser.newContext();
  try {
    await signIn(context, user);
    const page = await context.newPage();
    await page.goto(`${artifactOrigin(artifactId)}/`);
    const served = page.getByRole("heading", { name: "Team plan" });
    const refused = page.getByText("cannot be opened with this account");
    await expect(served.or(refused)).toBeVisible();
    return await served.isVisible();
  } finally {
    await context.close();
  }
}

test("an admin verifies an email domain and shares an artifact with it", async ({
  page,
  context,
  browser,
}) => {
  const domain = `acme-${crypto.randomUUID().slice(0, 8)}.com`;
  const admin = await createUser("Admin");
  const member = await createUser("Member");
  const colleague = await createUser("Dana", domain);
  const outsider = await createUser("Outsider");
  const workspace = await createWorkspace({
    slug: slug(),
    name: "Acme",
    admin,
    members: [{ user: member, role: "member" }],
  });
  await signIn(context, admin);

  await open(page, `/members?workspace=${workspace.slug}`, "Members");
  const domains = page.getByRole("region", { name: "Email domains" });
  await expect(domains.getByText("No email domain yet.")).toBeVisible();
  await domains.getByRole("textbox", { name: "Domain" }).fill(domain.toUpperCase());
  await domains.getByRole("button", { name: "Add domain" }).click();
  await expect(domains.getByText("Waiting for the DNS record")).toBeVisible();
  await expect(domains.getByText(`_portifact-email.${domain}`)).toBeVisible();
  await axeInBothThemes(page);

  // Verifying before the record exists says so; once the fake DNS holds it, it verifies.
  await domains.getByRole("button", { name: `Verify ${domain}` }).click();
  await expect(
    domains.getByText("The TXT record was not found with this domain's value yet", {
      exact: false,
    }),
  ).toBeVisible();
  const [claim] = await sql<{ token: string }>(
    "SELECT token FROM workspace_domains WHERE workspace_id = ?",
    [workspace.id],
  );
  await fakeDomains({
    txt: { name: `_portifact-email.${domain}`, value: `portifact-email-verify=${claim?.token}` },
  });
  await domains.getByRole("button", { name: `Verify ${domain}` }).click();
  await expect(domains.getByText("Verified", { exact: true })).toBeVisible();

  const { artifactId } = await publish({
    ownerId: admin.userId,
    targetOwnerId: workspace.id,
    name: "Team plan",
    files: { "index.html": PAGE },
    bar: false,
  });
  await open(page, `/artifacts/${artifactId}?workspace=${workspace.slug}`, "Team plan");
  const access = page.getByRole("region", { name: "Access" });
  await expect(access.getByText(`verified address at ${domain}`, { exact: false })).toBeVisible();
  await access.getByRole("radio", { name: "The workspace and its email domains" }).check();
  await access.getByRole("button", { name: "Save access" }).click();
  await expect
    .poll(
      async () =>
        (
          await sql<{ mode: string }>("SELECT access_mode AS mode FROM artifacts WHERE id = ?", [
            artifactId,
          ])
        )[0]?.mode,
    )
    .toBe("domain");
  await axeInBothThemes(page);

  expect(await opens(browser, member, artifactId)).toBe(true);
  expect(await opens(browser, colleague, artifactId)).toBe(true);
  expect(await opens(browser, outsider, artifactId)).toBe(false);
});

test("the workspace mode lets members in and nobody else, whatever their address", async ({
  browser,
}) => {
  const domain = `beta-${crypto.randomUUID().slice(0, 8)}.com`;
  const admin = await createUser("Admin");
  const member = await createUser("Member");
  const colleague = await createUser("Dana", domain);
  const outsider = await createUser("Outsider");
  const workspace = await createWorkspace({
    slug: slug(),
    name: "Beta",
    admin,
    members: [{ user: member, role: "member" }],
  });
  await sql(
    "INSERT INTO workspace_domains (id, workspace_id, domain, display, token, state, created_at, expires_at, verified_at, checked_at, failed_checks, problem) VALUES (?, ?, ?, NULL, ?, 'verified', ?, ?, ?, ?, 0, NULL)",
    [
      `wd_${crypto.randomUUID().replaceAll("-", "")}`,
      workspace.id,
      domain,
      "e".repeat(32),
      Date.now(),
      Date.now(),
      Date.now(),
      Date.now(),
    ],
  );
  const { artifactId } = await publish({
    ownerId: admin.userId,
    targetOwnerId: workspace.id,
    name: "Team plan",
    files: { "index.html": PAGE },
    accessMode: "workspace",
    bar: false,
  });
  expect(await opens(browser, member, artifactId)).toBe(true);
  expect(await opens(browser, colleague, artifactId)).toBe(false);
  expect(await opens(browser, outsider, artifactId)).toBe(false);
});
