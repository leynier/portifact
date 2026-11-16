// Live updates of artifact data (decision 0026, delivery 7) from a real page, in every engine.
// Chrome opens a WebSocket with `Origin` and no `Sec-Fetch-*` header, Firefox with
// `Sec-Fetch-Site: same-origin`: the handshake is let in either way from the artifact's own
// origin, and refused from any other, with or without fetch metadata (the production
// commissioning of 2026-11-16 found every Chrome connection refused).
import type { Page } from "@playwright/test";
import {
  contentRequests,
  control,
  createUser,
  expect,
  publish,
  signIn,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin } from "../src/hosts.ts";
import { DROP_FETCH_METADATA } from "../src/stack.ts";

const SITE = {
  "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Board</title>
<script src="/__portifact/data/data.js"></script></head><body><main><h1>Board</h1>
<p id="state">waiting</p>
<script>
window.changes = [];
window.board = {
  follow: () => { window.portifact.data.live(["notes"], (change) => window.changes.push(change)); },
  post: (text) => window.portifact.data.collection("notes").create({ text }).then(
    (doc) => ({ ok: true, doc }), (error) => ({ ok: false, status: error.status })),
  // A bare handshake to any artifact's live route: the first message, or how it ended.
  handshake: (url) => new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.addEventListener("message", (event) => { resolve(String(event.data)); socket.close(1000); });
    socket.addEventListener("close", (event) => resolve("closed:" + event.code));
  }),
};
window.portifact.data.me().then((me) => {
  document.getElementById("state").textContent = me.granted ? "granted" : "not granted";
});
</script></main></body></html>`,
};

async function board() {
  const owner = await createUser("Owner");
  const published = await publish({
    ownerId: owner.userId,
    name: "Board",
    accessMode: "public",
    bar: false,
    files: SITE,
  });
  await control("/data-collection", {
    ownerId: owner.userId,
    artifactId: published.artifactId,
    name: "notes",
    mode: "shared",
  });
  return published.artifactId;
}

function liveUrl(artifactId: string, dropFetchMetadata = false): string {
  const url = new URL(`${artifactOrigin(artifactId)}/__portifact/data/live`);
  url.protocol = "wss:";
  if (dropFetchMetadata) url.searchParams.set(DROP_FETCH_METADATA, "1");
  return url.href;
}

/** The live handshakes the content Worker saw for an artifact, as the front end recorded them. */
async function handshakes(artifactId: string) {
  const host = new URL(artifactOrigin(artifactId)).host;
  return (await contentRequests()).filter(
    (request) => request.host === host && request.path === "/__portifact/data/live",
  );
}

async function grantOnThePage(page: Page, artifactId: string) {
  await page.goto(`${artifactOrigin(artifactId)}/`);
  await expect(page.locator("#state")).toHaveText("not granted");
  await Promise.all([
    page.waitForURL((url) => url.origin === APP_ORIGIN),
    page.evaluate(() => location.assign("/__portifact/data/grant/begin?flow=top&to=/")),
  ]);
  await page.getByRole("heading", { name: /save what you enter/ }).waitFor();
  await page.getByRole("button", { name: "Allow" }).click();
  await page.waitForURL(`${artifactOrigin(artifactId)}/`);
  await expect(page.locator("#state")).toHaveText("granted");
}

test("a change arrives over the page's live connection in every engine", async ({
  page,
  context,
  browserName,
}) => {
  const artifactId = await board();
  await signIn(context, await createUser("Visitor"));
  await grantOnThePage(page, artifactId);

  const [socket] = await Promise.all([
    page.waitForEvent("websocket"),
    page.evaluate(() => window.board.follow()),
  ]);
  await socket.waitForEvent("framesent", (frame) => String(frame.payload).includes("subscribe"));
  expect(await page.evaluate(() => window.board.post("hello"))).toMatchObject({ ok: true });
  await expect
    .poll(() => page.evaluate(() => window.changes))
    .toContainEqual(expect.objectContaining({ collection: "notes", kind: "created" }));

  const [opened] = await handshakes(artifactId);
  expect(opened?.status).toBe(101);
  // What each engine sends on the handshake; Chrome's carries no fetch metadata at all.
  if (browserName === "chromium") expect(opened?.site).toBeNull();
  if (browserName === "firefox") expect(opened?.site).toBe("same-origin");
});

test("a handshake without fetch metadata connects from the artifact's own origin", async ({
  page,
}) => {
  const artifactId = await board();
  await page.goto(`${artifactOrigin(artifactId)}/`);
  await expect(page.locator("#state")).toHaveText("not granted");
  const first = await page.evaluate(
    (url) => window.board.handshake(url),
    liveUrl(artifactId, true),
  );
  expect(JSON.parse(first)).toMatchObject({ connected: expect.any(String) });
  const [opened] = await handshakes(artifactId);
  expect(opened).toMatchObject({ status: 101, site: null, mode: null, dest: null });
});

test("another artifact's page cannot open the live connection, with or without fetch metadata", async ({
  page,
}) => {
  const target = await board();
  const sibling = await board();
  await page.goto(`${artifactOrigin(sibling)}/`);
  await expect(page.locator("#state")).toHaveText("not granted");
  for (const drop of [false, true]) {
    const ended = await page.evaluate((url) => window.board.handshake(url), liveUrl(target, drop));
    expect(ended).toMatch(/^closed:/);
  }
  const refused = await handshakes(target);
  expect(refused.map((request) => request.status)).toEqual([403, 403]);
  expect(refused[1]?.site).toBeNull();
});

declare global {
  interface Window {
    changes: { collection: string; kind: string }[];
    board: {
      follow(): void;
      post(text: string): Promise<{ ok: boolean; status?: number }>;
      handshake(url: string): Promise<string>;
    };
  }
}
