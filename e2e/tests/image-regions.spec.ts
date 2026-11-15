// Image regions (decision 0028): a reviewer picks an image in the artifact, marks a rectangle of it
// in the viewer's own layer (with the keyboard and with the pointer), comments on it, and the thread
// is found again on the image. The region is stored with the image's file and the server's SHA-256.

import {
  artifactFrame,
  createUser,
  expect,
  openReview,
  publish,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";

const MOCK = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect width="400" height="200" fill="#eee"/><rect x="150" y="120" width="100" height="40" fill="#333"/></svg>`;

const SITE = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mockup</title></head><body><h1>Checkout mockup</h1><img id="mock" src="mock.svg" alt="Checkout screen" width="400" height="200"></body></html>',
  "mock.svg": MOCK,
};

interface StoredRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  image: { path: string; sha256: string };
}

async function regionsBy(userId: string): Promise<(StoredRegion | null)[]> {
  const rows = await sql<{ region: string | null }>(
    "SELECT region FROM annotation_threads WHERE author_id = ? ORDER BY created_at",
    [userId],
  );
  return rows.map((row) => (row.region ? (JSON.parse(row.region) as StoredRegion) : null));
}

test("a reviewer marks a region of an image and comments on it", async ({
  page,
  context,
  engine,
}) => {
  test.skip(!engine.reviewWorks, "the bridge never runs in this configuration");
  const owner = await createUser("Owner");
  const { artifactId } = await publish({ ownerId: owner.userId, name: "Mockup", files: SITE });
  await signIn(context, owner);
  await openReview(page, artifactId, "Mockup");
  await expect(page.getByRole("button", { name: "Select an element" })).toBeVisible();
  const frame = await artifactFrame(page, artifactId);
  await expect(frame.getByRole("img", { name: "Checkout screen" })).toBeVisible();

  // With the keyboard: move the starting rectangle right and make it taller.
  await page.getByRole("button", { name: "Select an element" }).click();
  await frame.getByRole("img", { name: "Checkout screen" }).click();
  await page.getByRole("button", { name: "Mark a region" }).click();
  const surface = page.getByRole("group", { name: "Region of mock.svg" });
  await expect(surface).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.getByText("From 27% to 77% across, 25% to 77% down.")).toBeAttached();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Region of mock.svg, 27% to 77% across, 25% to 77% down").first(),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Comment" }).fill("This button is too small");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("1 comment thread")).toBeVisible();

  // With the pointer: drag around the dark button of the mockup (150,120 to 250,160 of 400 by 200).
  await page.getByRole("button", { name: "Select an element" }).click();
  await frame.getByRole("img", { name: "Checkout screen" }).click();
  await page.getByRole("button", { name: "Mark a region" }).click();
  const box = await surface.boundingBox();
  if (!box) throw new Error("The region layer has no box");
  await page.mouse.move(box.x + box.width * 0.375, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.7, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.625, box.y + box.height * 0.8, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByText("From 38% to 63% across, 60% to 80% down.")).toBeAttached();
  await page.getByRole("button", { name: "Comment on this region" }).click();
  await page.getByRole("textbox", { name: "Comment" }).fill("Make this the primary color");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("2 comment threads")).toBeVisible();

  const [first, second] = await regionsBy(owner.userId);
  expect(first).toMatchObject({ x: 0.27, y: 0.25, width: 0.5, height: 0.52 });
  expect(first?.image.path).toBe("mock.svg");
  expect(first?.image.sha256).toMatch(/^[0-9a-f]{64}$/);
  // The pointer lands on whole pixels, so allow a pixel either way.
  expect(second?.x).toBeCloseTo(0.375, 2);
  expect(second?.y).toBeCloseTo(0.6, 2);
  expect(second?.width).toBeCloseTo(0.25, 2);
  expect(second?.height).toBeCloseTo(0.2, 2);

  // Both threads are found on the image, and the page's own element comment flow still works.
  await expect(page.getByRole("button", { name: "Show in the artifact" })).toHaveCount(2);
  await expect(page.getByText("Without location", { exact: true })).toHaveCount(0);
});

test("escape leaves the region layer without posting anything", async ({
  page,
  context,
  engine,
}) => {
  test.skip(!engine.reviewWorks, "the bridge never runs in this configuration");
  const owner = await createUser("Owner");
  const { artifactId } = await publish({ ownerId: owner.userId, name: "Mockup", files: SITE });
  await signIn(context, owner);
  await openReview(page, artifactId, "Mockup");
  const frame = await artifactFrame(page, artifactId);
  await page.getByRole("button", { name: "Select an element" }).click();
  await frame.getByRole("img", { name: "Checkout screen" }).click();
  await page.getByRole("button", { name: "Mark a region" }).click();
  await expect(page.getByRole("group", { name: "Region of mock.svg" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "Region of mock.svg" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Comment" })).toHaveCount(0);
  expect(await regionsBy(owner.userId)).toEqual([]);
});
