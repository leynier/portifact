// Artifact data from the page (decision 0026, delivery 6), in every engine with third-party
// cookies blocked: a visitor allows the page in a control Portifact draws, through the same tab,
// a popup or the viewer's frame (with the top-level tab as the fallback where the frame cannot
// keep its partitioned cookie); the page then knows only an opaque ID and the display name and
// writes as the visitor; a code made in another browser makes nobody an author; revoking stops
// writes within a minute.
import type { Page } from "@playwright/test";
import {
  control,
  createUser,
  expect,
  openReview,
  publish,
  setContentClock,
  signIn,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin, bounced } from "../src/hosts.ts";

/** The artifact's page: the client script and a few helpers the test drives through `window`. */
const SITE = {
  "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Votes</title>
<script src="/__portifact/data/data.js"></script></head><body><main><h1>Votes</h1>
<button id="allow" type="button">Save as me</button><p id="state">waiting</p>
<script>
window.page = {
  me: () => window.portifact.data.me(),
  vote: (choice) => window.portifact.data.collection("votes").create({ choice }).then(
    (doc) => ({ ok: true, doc }), (error) => ({ ok: false, status: error.status })),
  mine: () => window.portifact.data.mine(),
};
window.portifact.data.me().then((me) => {
  document.getElementById("state").textContent = me.granted ? "granted:" + me.visitor.name : "not granted";
});
document.getElementById("allow").addEventListener("click", () => {
  window.portifact.data.allow().then((granted) => {
    document.getElementById("state").textContent = granted ? "allowed" : "refused";
  });
});
</script></main></body></html>`,
};

async function votingArtifact(bar: boolean) {
  const owner = await createUser("Owner");
  const published = await publish({
    ownerId: owner.userId,
    name: "Votes",
    accessMode: "public",
    bar,
    files: SITE,
  });
  await control("/data-collection", {
    ownerId: owner.userId,
    artifactId: published.artifactId,
    name: "votes",
    mode: "own",
  });
  return published.artifactId;
}

/** The page starts the grant in its own tab: only its own navigation passes `beginGate`. */
async function beginInThisTab(page: Page, artifactId: string) {
  if (!page.url().startsWith(artifactOrigin(artifactId)))
    await page.goto(`${artifactOrigin(artifactId)}/`);
  await page.locator("#state").filter({ hasNotText: "waiting" }).waitFor();
  await Promise.all([
    page.waitForURL((url) => url.origin === APP_ORIGIN),
    page.evaluate(() => location.assign("/__portifact/data/grant/begin?flow=top&to=/")),
  ]);
}

async function allowOnTheControl(control: Page) {
  await control.getByRole("heading", { name: /save what you enter/ }).waitFor();
  await expect(control.getByText(/never learns your email/)).toBeVisible();
  await control.getByRole("button", { name: "Allow" }).click();
}

test("the same tab: the page knows only the visitor's ID and name and writes as them", async ({
  page,
  context,
}) => {
  const artifactId = await votingArtifact(false);
  const visitor = await createUser("Visitor");
  await signIn(context, visitor);
  await page.goto(`${artifactOrigin(artifactId)}/`);
  await expect(page.locator("#state")).toHaveText("not granted");
  // Not signed in to the page yet: nothing names the visitor, and nothing is written.
  expect(await page.evaluate(() => window.page.vote("a"))).toMatchObject({
    ok: false,
    status: 403,
  });

  // The same tab: the page sends itself to begin; the control is on the app.
  await beginInThisTab(page, artifactId);
  await allowOnTheControl(page);
  await page.waitForURL(`${artifactOrigin(artifactId)}/`);
  await expect(page.locator("#state")).toHaveText(`granted:${visitor.name}`);
  const me = await page.evaluate(() => window.page.me());
  expect(JSON.stringify(me)).not.toContain(visitor.email);
  const vote = await page.evaluate(() => window.page.vote("a"));
  expect(vote).toMatchObject({ ok: true, doc: { choice: "a", _by: me.visitor.id } });
});

test("a popup: the page opens the control, which tells its opener and closes", async ({
  page,
  context,
}) => {
  const artifactId = await votingArtifact(false);
  await signIn(context, await createUser("Visitor"));
  await page.goto(`${artifactOrigin(artifactId)}/`);
  await expect(page.locator("#state")).toHaveText("not granted");
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Save as me" }).click(),
  ]);
  await allowOnTheControl(popup);
  await expect(page.locator("#state")).toHaveText("allowed");
  expect(await page.evaluate(() => window.page.vote("b"))).toMatchObject({ ok: true });
});

test("the viewer's frame, or the top-level tab where the frame cannot keep the grant", async ({
  page,
  context,
  engine,
}) => {
  const artifactId = await votingArtifact(true);
  await signIn(context, await createUser("Visitor"));
  await openReview(page, artifactId, "Votes");
  const frame = page.frameLocator("iframe");
  await frame.getByRole("button", { name: "Save as me" }).click();
  // The viewer draws the control itself; the page only asked.
  await page.getByRole("button", { name: "Allow" }).click();
  if (engine.reviewWorks) {
    await expect(frame.locator("#state")).toHaveText(/^granted:/);
  } else {
    await expect(page.getByText("Saving is not available in this frame")).toBeVisible();
    const tab = page.getByRole("link", { name: "Open in a new tab" });
    await expect(tab).toHaveAttribute("href", `${artifactOrigin(artifactId)}/`);
  }
});

test("a code made for another browser makes nobody an author", async ({
  page,
  context,
  browser,
}) => {
  const artifactId = await votingArtifact(false);
  const visitor = await createUser("Visitor");
  await signIn(context, visitor);
  // The other browser starts the grant and stops at the app's redirect with its code.
  const other = await browser.newContext();
  await signIn(other, visitor);
  const otherPage = await other.newPage();
  let code: string | null = null;
  otherPage.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/__portifact/data/grant") code = url.searchParams.get("code");
  });
  await otherPage.route(`${artifactOrigin(artifactId)}/__portifact/data/grant?**`, (route) =>
    route.abort(),
  );
  await beginInThisTab(otherPage, artifactId);
  await allowOnTheControl(otherPage);
  await expect.poll(() => code).not.toBeNull();
  await other.close();

  // This browser never began that grant: arriving cross-site with the code, it redeems nothing.
  await page.goto(
    bounced(`${artifactOrigin(artifactId)}/__portifact/data/grant?flow=top&code=${code}`),
  );
  await expect(page.getByRole("heading", { name: "Saving is not available here" })).toBeVisible();
  await page.goto(`${artifactOrigin(artifactId)}/`);
  await expect(page.locator("#state")).toHaveText("not granted");
});

test("revoking from Data you shared stops writes within a minute", async ({ page, context }) => {
  const artifactId = await votingArtifact(false);
  await signIn(context, await createUser("Visitor"));
  await beginInThisTab(page, artifactId);
  await allowOnTheControl(page);
  await page.waitForURL(`${artifactOrigin(artifactId)}/`);
  expect(await page.evaluate(() => window.page.vote("a"))).toMatchObject({ ok: true });

  await page.goto(`${APP_ORIGIN}/shared-data`);
  await page.getByRole("button", { name: "Revoke Votes" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("Ended")).toBeVisible();

  await setContentClock(artifactId, 61_000);
  await page.goto(`${artifactOrigin(artifactId)}/`);
  await expect(page.locator("#state")).toHaveText("not granted");
  expect(await page.evaluate(() => window.page.vote("b"))).toMatchObject({
    ok: false,
    status: 403,
  });
});

declare global {
  interface Window {
    page: {
      me(): Promise<{ granted: boolean; visitor: { id: string; name: string } }>;
      vote(choice: string): Promise<{ ok: boolean; status?: number; doc?: unknown }>;
      mine(): Promise<unknown>;
    };
    portifact: { data: { me(): Promise<unknown> } };
  }
}
