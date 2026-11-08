// Review of a client-rendered app (docs/anchors.md): the page's DOM exists only after its script
// runs, a hash router replaces it on every navigation, and the bridge must still turn text
// selections and picked elements into targets with the SPA route, report targets of another
// route as without location, and find them again in the freshly rendered DOM.

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

// A tiny shop with a hash router and no dependencies. Every render throws away the old nodes,
// and the home view gains a visit counter line above its text, so a re-rendered page has new
// nodes and shifted offsets.
const APP = `
const views = {
  "#/": (visits) => \`
    <header><h1>Tiny shop</h1><nav><a href="#/">Home</a> <a href="#/about">About</a></nav></header>
    \${visits > 1 ? \`<p class="visits">Visit number \${visits}</p>\` : ""}
    <section class="products">
      <article class="product" data-testid="kettle">
        <h2>Copper kettle</h2>
        <p class="pitch">Boils water quietly before your morning coffee is ground.</p>
        <button type="button" data-testid="add-kettle">Add to cart</button>
      </article>
    </section>\`,
  "#/about": () => \`
    <header><h1>Tiny shop</h1><nav><a href="#/">Home</a> <a href="#/about">About</a></nav></header>
    <section><h2>About us</h2><p>Two people and a workshop.</p></section>\`,
};
let visits = 0;
function render() {
  const route = views[location.hash] ? location.hash : "#/";
  if (route === "#/") visits += 1;
  const root = document.getElementById("app");
  root.replaceChildren();
  const fresh = document.createElement("main");
  fresh.innerHTML = views[route](visits);
  root.append(fresh);
  document.title = route === "#/" ? "Tiny shop" : "About the tiny shop";
}
window.addEventListener("hashchange", render);
window.addEventListener("load", () => {
  if (!location.hash) history.replaceState(null, "", "#/");
  setTimeout(render, 200);
});
`;

const SITE = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Loading</title></head><body><div id="app"></div><script src="app.js"></script></body></html>',
  "app.js": APP,
};

interface StoredTarget {
  route?: string;
  anchor: {
    kind: string;
    quote?: { exact: string };
    selectors?: string[];
    tagName?: string;
  };
}

async function targetsBy(userId: string): Promise<StoredTarget[]> {
  const rows = await sql<{ target: string }>(
    "SELECT target FROM annotation_threads WHERE author_id = ? ORDER BY created_at",
    [userId],
  );
  return rows.map((row) => JSON.parse(row.target) as StoredTarget);
}

test("the bridge anchors selections in a client-rendered app and finds them after re-renders", async ({
  page,
  context,
  engine,
}) => {
  test.skip(!engine.reviewWorks, "the bridge never runs in this configuration");
  const owner = await createUser("Owner");
  const { artifactId } = await publish({ ownerId: owner.userId, name: "Tiny shop", files: SITE });
  await signIn(context, owner);
  await openReview(page, artifactId, "Tiny shop");
  await expect(page.getByRole("button", { name: "Select an element" })).toBeVisible();
  const frame = await artifactFrame(page, artifactId);
  // Nothing of the shop is in the served HTML; it appears once the script renders it.
  await expect(frame.getByRole("heading", { name: "Copper kettle" })).toBeVisible();

  // A text selection inside the rendered view becomes a text target on the SPA route.
  await frame.locator(".pitch").selectText();
  await page.getByRole("button", { name: "Comment on the selection" }).click();
  await page.getByRole("textbox", { name: "Comment" }).fill("Mention the warranty");
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByText("1 comment thread")).toBeVisible();

  // Element mode picks a button the script created.
  await page.getByRole("button", { name: "Select an element" }).click();
  await frame.getByTestId("add-kettle").click();
  await expect(page.getByText("Element button")).toBeVisible();
  await page.getByRole("textbox", { name: "Comment" }).fill("Make this the primary action");
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByText("2 comment threads")).toBeVisible();

  const [text, element] = await targetsBy(owner.userId);
  expect(text).toMatchObject({
    route: "/#/",
    anchor: {
      kind: "text",
      quote: { exact: "Boils water quietly before your morning coffee is ground." },
    },
  });
  expect(element).toMatchObject({ route: "/#/", anchor: { kind: "element", tagName: "button" } });
  expect(element?.anchor.selectors?.[0]).toContain('[data-testid="add-kettle"]');

  const threads = page.getByRole("article", { name: /^Thread \d$/ });
  const shown = page.getByRole("button", { name: "Show in the artifact" });
  const orphaned = page.getByText("Without location", { exact: true });
  await expect(shown).toHaveCount(2);
  await expect(threads).toHaveCount(2);

  // Another route: the router replaced the DOM, and both targets belong to the home route.
  await frame.getByRole("link", { name: "About" }).click();
  await expect(frame.getByRole("heading", { name: "About us" })).toBeVisible();
  await expect(orphaned).toHaveCount(2);
  await expect(shown).toHaveCount(0);

  // Back home the view is rendered from scratch, with a new line above the quote, and the
  // bridge finds both targets in the new nodes.
  await frame.getByRole("link", { name: "Home" }).click();
  await expect(frame.getByText("Visit number 2")).toBeVisible();
  await expect(orphaned).toHaveCount(0);
  await expect(shown).toHaveCount(2);

  // A selection made after the re-render anchors in the new DOM too.
  await frame.getByRole("heading", { name: "Copper kettle" }).selectText();
  await expect(page.getByRole("button", { name: "Comment on the selection" })).toBeVisible();
  await page.getByRole("button", { name: "Comment on the selection" }).click();
  await page.getByRole("textbox", { name: "Comment" }).fill("Name the size");
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByText("3 comment threads")).toBeVisible();
  const third = (await targetsBy(owner.userId))[2];
  expect(third).toMatchObject({
    route: "/#/",
    anchor: { kind: "text", quote: { exact: "Copper kettle" } },
  });
  await expect(shown).toHaveCount(3);
});
