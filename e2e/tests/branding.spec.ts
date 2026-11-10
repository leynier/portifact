// The owner's brand on the viewer's bar end to end (premium plan P9): on free the Branding page
// says it is part of a paid plan; on Pro the owner sets a name, link, color and logo with a
// preview in both themes; a visitor's viewer shows the brand with the logo from the artifact's
// own origin, under the viewer's real policy, while Portifact, the real origin and the report link
// stay in view; an operator suspension brings back the default bar.

import { png } from "@portifact/domain/testing/images";
import { axeViolations } from "../src/axe.ts";
import { createUser, expect, grantPlan, publish, signIn, sql, test } from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin } from "../src/hosts.ts";

test("an owner on Pro brands the viewer's bar and a visitor sees it with Portifact still named", async ({
  page,
  context,
  browser,
}) => {
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    name: "Quarterly report",
    accessMode: "public",
    files: { "index.html": "<!doctype html><title>Report</title><h1>Report</h1>" },
  });
  await signIn(context, owner);

  // Free: a note, no form and no upgrade button.
  await page.goto(`${APP_ORIGIN}/branding`);
  await expect(page.getByText("Branding is part of a paid plan")).toBeVisible();
  await expect(page.getByRole("region", { name: "Brand" })).toHaveCount(0);

  await grantPlan(owner.userId, "pro");
  await page.reload();
  const form = page.getByRole("region", { name: "Brand" });
  await form.getByRole("textbox", { name: /^Name/ }).fill("Acme Labs");
  await form.getByRole("textbox", { name: /^Link/ }).fill("https://acme.example.com");
  // The color is typed: the keyboard path never needs the picker.
  await form.getByRole("textbox", { name: /^Accent color/ }).fill("#0057b8");
  const preview = page.getByRole("region", { name: "Preview" });
  await expect(preview.getByRole("figure", { name: "Light theme" })).toContainText("Acme Labs");
  await expect(preview.getByRole("figure", { name: "Dark theme" })).toContainText(
    "Powered by Portifact",
  );
  await form.getByRole("button", { name: "Save brand" }).click();
  await expect(page.getByText("Brand saved.").first()).toBeAttached();

  const logo = page.getByRole("region", { name: "Logo" });
  await logo.locator('input[type="file"]').setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: Buffer.from(png({ width: 64, height: 32 })),
  });
  await expect(logo.getByText(/^PNG, 64 by 32 pixels/)).toBeVisible();
  // The preview's logo comes from the app's session-only route and really loads.
  const previewLogo = preview.getByRole("figure", { name: "Light theme" }).locator("img").nth(0);
  await expect
    .poll(() => previewLogo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(64);
  // An SVG is refused whatever it is called.
  await logo.locator('input[type="file"]').setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  });
  await expect(logo.getByText(/^Use a PNG, JPEG or WebP image/)).toBeVisible();

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    expect(await axeViolations(page), scheme).toEqual([]);
  }

  // A visitor who is not signed in opens the artifact's link and lands in the branded viewer.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  try {
    await visitor.goto(`${artifactOrigin(artifactId)}/`);
    await expect(visitor).toHaveURL(`${APP_ORIGIN}/view/${artifactId}`);
    const bar = visitor.getByRole("banner");
    const home = bar.getByRole("link", { name: "Acme Labs (opens in a new tab)" });
    await expect(home).toHaveAttribute("href", "https://acme.example.com/");
    await expect(home).toHaveAttribute("rel", "noopener noreferrer");
    const brandLogo = home.locator("img");
    await expect(brandLogo).toHaveAttribute(
      "src",
      new RegExp(`^${artifactOrigin(artifactId)}/__portifact/brand/[0-9a-f]{64}$`),
    );
    // Loaded under the viewer's own policy, from the artifact's origin.
    await expect
      .poll(() => brandLogo.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(64);
    await expect(visitor.getByText("Powered by Portifact")).toBeVisible();
    await expect(visitor.getByText(`${artifactId}.portifact-content.test`)).toBeVisible();
    await expect(visitor.getByRole("link", { name: "Report this artifact" }).first()).toBeVisible();
    await visitor.emulateMedia({ reducedMotion: "reduce" });
    expect(await axeViolations(visitor)).toEqual([]);

    // The operator suspends the brand: the default bar, at once.
    await sql(
      "UPDATE owner_brands SET suspended_at = ?, suspension_reason = 'impersonation' WHERE owner_id = ?",
      [Date.now(), owner.userId],
    );
    await visitor.reload();
    await expect(
      visitor.getByRole("banner").getByRole("link", { name: "Portifact" }),
    ).toBeVisible();
    await expect(visitor.getByText("Powered by Portifact")).toHaveCount(0);
  } finally {
    await visitorContext.close();
  }

  await page.reload();
  await expect(page.getByText("Your brand is suspended")).toBeVisible();
});
