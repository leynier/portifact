import { APP_HOST, type ArtifactId, artifactOrigin } from "./hosts.ts";

const APP_ORIGIN = `https://${APP_HOST}`;

// Inline scripts keep the spike self-contained. Values are JSON-encoded before they reach HTML.
function json(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

// Trusted viewer. It asks its own API for a one-time code and points the iframe at the
// content origin's exchange endpoint. It also carries the two fallbacks under test.
export function viewerPage(id: ArtifactId, path: string): string {
  const config = json({ artifact: id, origin: artifactOrigin(id), path });
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Review ${id}</title></head>
<body>
<h1>Trusted viewer for ${id}</h1>
<iframe id="artifact" title="Artifact under review" width="800" height="400"
  sandbox="allow-scripts allow-same-origin allow-forms allow-storage-access-by-user-activation"></iframe>
<button id="open-tab" type="button">Open review in a new tab</button>
<script>
const config = ${config};
const frame = document.getElementById("artifact");
async function exchangeUrl(path) {
  const response = await fetch("/api/review-codes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifact: config.artifact, path }),
  });
  const { code } = await response.json();
  return config.origin + "/__portifact/review?code=" + encodeURIComponent(code);
}
// Last-resort fallback: a top-level review tab. The window opens synchronously inside the
// click so popup blockers allow it, and drops its opener before it reaches the artifact.
document.getElementById("open-tab").addEventListener("click", () => {
  const tab = window.open("about:blank", "_blank");
  if (!tab) return;
  tab.opener = null;
  exchangeUrl(config.path).then((url) => { tab.location.href = url; });
});
// Storage Access fallback: after a grant the frame navigates itself to a fresh exchange URL,
// so the navigation happens inside the document that holds the grant.
window.storageAccessResult = null;
window.addEventListener("message", (event) => {
  if (event.origin !== config.origin || event.source !== frame.contentWindow) return;
  if (!event.data || event.data.type !== "storage-access-result") return;
  window.storageAccessResult = String(event.data.result);
  if (!window.storageAccessResult.startsWith("granted")) return;
  exchangeUrl(config.path).then((url) => {
    frame.contentWindow.postMessage({ type: "review-url", url }, config.origin);
  });
});
exchangeUrl(config.path).then((url) => { frame.src = url; });
</script>
</body>
</html>`;
}

export function artifactPage(id: ArtifactId, mode: "review" | "public"): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${id}</title>
<link rel="stylesheet" href="/style.css">
<script src="/app.js" defer></script>
</head>
<body data-artifact="${id}" data-mode="${mode}">
<h1>${id} (${mode})</h1>
<img id="pixel" src="/pixel.svg" alt="" width="10" height="10">
<a id="next" href="/other.html">Other page</a>
<button id="grant" type="button">Allow review access</button>
</body>
</html>`;
}

// Artifact script: fetches data with the default credentials mode and exposes helpers the
// tests call through Playwright. The Storage Access request lives here because only the
// embedded document can request access for itself.
export const artifactScript = `
window.spike = {
  data: fetch("/data.json").then((response) => response.json()),
  async refetch() {
    const response = await fetch("/data.json", { cache: "no-store" });
    return response.json();
  },
};
// After a grant the exchange runs as a same-document fetch first, then the frame reloads, so
// the spike can tell whether the grant covers requests from the granting document only or
// also the next document in the frame.
window.addEventListener("message", async (event) => {
  if (event.origin !== "${APP_ORIGIN}" || event.source !== window.parent) return;
  const url = event.data && event.data.type === "review-url" ? String(event.data.url) : "";
  if (!url.startsWith(location.origin + "/__portifact/review?")) return;
  await fetch(url, { credentials: "include", redirect: "manual" });
  window.spike.afterGrant = await window.spike.refetch();
  sessionStorage.setItem("pf-spike-after-grant", JSON.stringify(window.spike.afterGrant));
  location.reload();
});
window.spike.previousAfterGrant = JSON.parse(sessionStorage.getItem("pf-spike-after-grant") || "null");
document.getElementById("grant").addEventListener("click", async () => {
  let result = "granted";
  try {
    await document.requestStorageAccess();
    document.cookie = "saa_probe=1; Path=/; Secure; SameSite=None";
    result += "; document.cookie=" + document.cookie;
  } catch (error) {
    result = "denied: " + String(error);
  }
  window.parent.postMessage({ type: "storage-access-result", result }, "${APP_ORIGIN}");
});
`;

export const artifactStyle = "body { font-family: sans-serif; }\n";

export const pixelSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
