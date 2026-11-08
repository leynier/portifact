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
