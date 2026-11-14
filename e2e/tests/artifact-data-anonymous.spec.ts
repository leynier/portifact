// Anonymous writers of artifact data (decision 0026, delivery 9), in every engine with
// third-party cookies blocked: a visitor without an account allows a public artifact's page in a
// control Portifact draws, behind the human check; the page then knows only an opaque ID and
// writes as it, in a `shared` collection where another anonymous visitor sees the note. Where the
// owner did not open the data to anyone, the control asks the visitor to sign in instead.
import type { Page } from "@playwright/test";
import { control, createUser, expect, openReview, publish, test } from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin } from "../src/hosts.ts";

/** The artifact's page: the client script and a few helpers the test drives through `window`. */
const SITE = {
  "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Guestbook</title>
<script src="/__portifact/data/data.js"></script></head><body><main><h1>Guestbook</h1>
<button id="allow" type="button">Sign the guestbook</button><p id="state">waiting</p>
<script>
window.guest = {
  me: () => window.portifact.data.me(),
  sign: (text) => window.portifact.data.collection("notes").create({ text }).then(
    (doc) => ({ ok: true, doc }), (error) => ({ ok: false, status: error.status })),
  notes: () => window.portifact.data.collection("notes").list(),
};
window.portifact.data.me().then((me) => {
  document.getElementById("state").textContent = me.granted ? (me.anonymous ? "anonymous" : "granted") : "not granted";
});
document.getElementById("allow").addEventListener("click", () => {
  window.portifact.data.allow().then((granted) => {
    document.getElementById("state").textContent = granted ? "allowed" : "refused";
  });
});
</script></main></body></html>`,
};

async function guestbook(writers: "anyone" | "signed_in", bar = false) {
  const owner = await createUser("Owner");
  const published = await publish({
    ownerId: owner.userId,
    name: "Guestbook",
    accessMode: "public",
    bar,
    files: SITE,
  });
  await control("/data-collection", {
    ownerId: owner.userId,
    artifactId: published.artifactId,
    name: "notes",
    mode: "shared",
    writers,
  });
  return published.artifactId;
}

/** The page starts the grant in its own tab: only its own navigation passes `beginGate`. */
async function beginInThisTab(page: Page, artifactId: string) {
  await page.goto(`${artifactOrigin(artifactId)}/`);
  await page.locator("#state").filter({ hasNotText: "waiting" }).waitFor();
  await Promise.all([
    page.waitForURL((url) => url.origin === APP_ORIGIN),
    page.evaluate(() => location.assign("/__portifact/data/grant/begin?flow=top&to=/")),
  ]);
}

test("a visitor without an account allows the page and writes as an opaque ID", async ({
  page,
  browser,
}) => {
  const artifactId = await guestbook("anyone");
  await page.goto(`${artifactOrigin(artifactId)}/`);
  await expect(page.locator("#state")).toHaveText("not granted");
  expect(await page.evaluate(() => window.guest.sign("before"))).toMatchObject({
    ok: false,
    status: 403,
  });

  await beginInThisTab(page, artifactId);
  // The control is Portifact's, on the app: it says what the page learns and runs the human check.
  await page.getByRole("heading", { name: /without an account/ }).waitFor();
  await expect(page.getByText(/no name, no email and no account/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in instead" })).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();
  await page.waitForURL(`${artifactOrigin(artifactId)}/`);
  await expect(page.locator("#state")).toHaveText("anonymous");
  const me = await page.evaluate(() => window.guest.me());
  expect(me).toMatchObject({ granted: true, anonymous: true, visitor: { name: "" } });
  const signed = await page.evaluate(() => window.guest.sign("hello"));
  expect(signed).toMatchObject({ ok: true, doc: { text: "hello", _by: me.visitor.id } });

  // Another browser without an account reads the shared note, and nothing names the writer.
  const other = await browser.newContext();
  try {
    const reader = await other.newPage();
    await reader.goto(`${artifactOrigin(artifactId)}/`);
    await expect(reader.locator("#state")).toHaveText("not granted");
    const notes = await reader.evaluate(() => window.guest.notes());
    expect(notes.documents).toMatchObject([{ text: "hello", _by: me.visitor.id }]);
  } finally {
    await other.close();
  }
});

test("where the owner did not open the data to anyone, the control asks to sign in", async ({
  page,
}) => {
  const artifactId = await guestbook("signed_in");
  await beginInThisTab(page, artifactId);
  await expect(page.getByText(/saves only for people who sign in/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow" })).toHaveCount(0);
  await page.goto(`${artifactOrigin(artifactId)}/`);
  expect(await page.evaluate(() => window.guest.sign("nope"))).toMatchObject({
    ok: false,
    status: 403,
  });
});

test("the viewer's frame, or the top-level tab where the frame cannot keep the grant", async ({
  page,
  engine,
}) => {
  const artifactId = await guestbook("anyone", true);
  await openReview(page, artifactId, "Guestbook");
  const frame = page.frameLocator("iframe");
  await frame.getByRole("button", { name: "Sign the guestbook" }).click();
  // The viewer draws the anonymous control itself; the page only asked.
  await page.getByRole("button", { name: "Allow" }).click();
  if (engine.reviewWorks) {
    await expect(frame.locator("#state")).toHaveText(/^(allowed|anonymous)$/);
  } else {
    await expect(page.getByText("Saving is not available in this frame")).toBeVisible();
  }
});

declare global {
  interface Window {
    guest: {
      me(): Promise<{
        granted: boolean;
        anonymous?: boolean;
        visitor: { id: string; name: string };
      }>;
      sign(text: string): Promise<{ ok: boolean; status?: number; doc?: unknown }>;
      notes(): Promise<{ documents: unknown[] }>;
    };
  }
}
