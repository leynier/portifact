// Custom domains in the dashboard (decision 0006), with the stack's fake Cloudflare and DNS: a Pro
// owner adds a hostname, copies the records, the TXT proof and the certificate turn it active, the
// note about the Portifact bar offers to turn it off, and removing asks first. A free owner gets
// the explanation and no form. Serving an artifact on the custom host itself comes with the
// content Worker's part of the feature.

import { axeViolations } from "../src/axe.ts";
import {
  createUser,
  expect,
  fakeDomains,
  grantPlan,
  publish,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN, CONTENT_SITE } from "../src/hosts.ts";

test("a Pro owner adds, verifies and removes a custom domain", async ({ page, context }) => {
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    name: "Docs",
    files: { "index.html": "<h1>Docs</h1>" },
  });
  await signIn(context, owner);
  const hostname = `docs-${artifactId}.example.com`;

  // Free: the explanation and no form.
  await page.goto(`${APP_ORIGIN}/artifacts/${artifactId}`);
  const panel = page.getByRole("region", { name: "Custom domain" });
  await expect(panel.getByText("Custom domains are part of a paid plan")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Add domain" })).toHaveCount(0);

  await grantPlan(owner.userId, "pro");
  await page.reload();
  await panel.getByRole("textbox", { name: "Hostname" }).fill(hostname);
  await panel.getByRole("button", { name: "Add domain" }).click();
  await expect(panel.getByText("Waiting for DNS")).toBeVisible();
  await expect(panel.getByText(`_portifact.${hostname}`)).toBeVisible();
  await expect(panel.getByText(`domains.${CONTENT_SITE}`)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // Checking before the record exists says what is missing.
  await panel.getByRole("button", { name: "Check again" }).click();
  await expect(panel.getByText("The TXT record was not found")).toBeVisible();

  // The customer publishes the record; Cloudflare then issues the certificate.
  const [claim] = await sql<{ token: string }>(
    "select token from domain_claims where hostname = ?",
    [hostname],
  );
  await fakeDomains({
    txt: { name: `_portifact.${hostname}`, value: `portifact-verify=${claim?.token}` },
  });
  await panel.getByRole("button", { name: "Check again" }).click();
  await expect(panel.getByText("Setting up")).toBeVisible();
  await fakeDomains({ activate: hostname });
  await panel.getByRole("button", { name: "Check again" }).click();
  await expect(panel.getByText("Active", { exact: true })).toBeVisible();
  expect(
    await sql<{ custom_host: string }>("select custom_host from artifacts where id = ?", [
      artifactId,
    ]),
  ).toEqual([{ custom_host: hostname }]);

  // The bar stays on until the owner turns it off here.
  const bar = await sql<{ bar: number }>("select bar from artifacts where id = ?", [artifactId]);
  expect(bar).toEqual([{ bar: 1 }]);
  await panel.getByRole("button", { name: "Turn off the bar" }).click();
  await expect(
    panel.getByText("Visits open in the viewer while the Portifact bar is on"),
  ).toHaveCount(0);
  expect(
    await sql<{ bar: number }>("select bar from artifacts where id = ?", [artifactId]),
  ).toEqual([{ bar: 0 }]);

  // Removing asks first and stops serving at once.
  await panel.getByRole("button", { name: "Remove domain" }).click();
  const dialog = page.getByRole("dialog", { name: `Remove ${hostname}?` });
  await dialog.getByRole("button", { name: "Remove domain" }).click();
  await expect(panel.getByText(`${hostname} is being removed.`)).toBeVisible();
  expect(
    await sql<{ custom_host: string | null }>("select custom_host from artifacts where id = ?", [
      artifactId,
    ]),
  ).toEqual([{ custom_host: null }]);
});
