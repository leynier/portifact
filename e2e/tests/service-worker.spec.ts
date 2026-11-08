// Service worker blocking ("Requests and responses" in docs/security.md): an artifact cannot
// register a service worker, which could intercept requests the platform must see. The browser
// fetches the worker script with `Service-Worker: script`, and the content Worker answers 403,
// whatever the path, so registration fails in every engine.

import { contentRequests, createUser, expect, publish, test } from "../src/fixtures.ts";
import { artifactOrigin } from "../src/hosts.ts";

const WORKER =
  "self.addEventListener('fetch', (event) => event.respondWith(new Response('owned')));";

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Offline app</title></head><body><h1>Offline app</h1><pre id="results"></pre><script src="register.js"></script></body></html>`;

// Tries the worker at its own path and at the path of a script the page already loaded, and
// reports each outcome; no exception may escape, so the page always finishes.
const REGISTER = `
(async () => {
  const results = {};
  if (!("serviceWorker" in navigator)) {
    results.api = "missing";
  } else {
    for (const path of ["/sw.js", "/register.js"]) {
      try {
        await navigator.serviceWorker.register(path, { scope: "/" });
        results[path] = "registered";
      } catch (error) {
        results[path] = "refused: " + (error && error.name);
      }
    }
    results.registrations = (await navigator.serviceWorker.getRegistrations()).length;
    results.controlled = navigator.serviceWorker.controller !== null;
  }
  results.done = true;
  document.getElementById("results").textContent = JSON.stringify(results);
})();
`;

test("an artifact cannot register a service worker", async ({ page }) => {
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    name: "Offline app",
    bar: false,
    accessMode: "public",
    files: { "index.html": PAGE, "register.js": REGISTER, "sw.js": WORKER },
  });
  const before = (await contentRequests()).length;

  await page.goto(`${artifactOrigin(artifactId)}/`);
  const results = page.locator("#results");
  await expect
    .poll(async () => JSON.parse((await results.textContent()) || "{}").done, { timeout: 20_000 })
    .toBe(true);
  const outcome = JSON.parse((await results.textContent()) ?? "{}") as Record<string, unknown>;

  // The API exists in every engine here, so a refusal below is the platform's doing.
  expect(outcome.api).toBeUndefined();
  expect(outcome["/sw.js"]).toMatch(/^refused/);
  expect(outcome["/register.js"]).toMatch(/^refused/);
  expect(outcome.registrations).toBe(0);
  expect(outcome.controlled).toBe(false);

  // The browser asked for each script as a service worker, and the Worker refused it, while the
  // same files load normally as page resources.
  const sent = (await contentRequests()).slice(before).filter((r) => r.host.startsWith(artifactId));
  for (const path of ["/sw.js", "/register.js"]) {
    const asWorker = sent.filter((r) => r.path === path && r.dest === "serviceworker");
    expect(asWorker.length, path).toBeGreaterThan(0);
    for (const request of asWorker) expect(request.status, path).toBe(403);
  }
  expect(
    sent.some((r) => r.path === "/register.js" && r.dest === "script" && r.status === 200),
  ).toBe(true);

  // The page still loads normally afterwards; nothing intercepts it.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Offline app" })).toBeVisible();
  expect(await page.evaluate(() => navigator.serviceWorker?.controller ?? null)).toBeNull();
  const direct = await page.request.get(`${artifactOrigin(artifactId)}/sw.js`, {
    headers: { "Service-Worker": "script" },
  });
  expect(direct.status()).toBe(403);
  expect(await direct.text()).toContain("Service workers are not allowed on artifacts");
});
