import { APP_ORIGIN, type ArtifactId, artifactOrigin } from "./hosts.ts";

// Inline pages keep the spike self-contained. Values are JSON-encoded before they reach HTML.
function json(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The viewer on the app origin: it frames the artifact and draws the consent control itself. The
 * frame flow: the viewer sends its frame to `begin`, which posts the nonce's hash to the viewer
 * (exact origin), the person chooses Allow in the viewer, the viewer asks its API for a code and
 * sends the frame to `grant?code=…`. When the frame reports that the cookie cannot be kept, the
 * viewer offers the top-level tab.
 */
export function viewerPage(id: ArtifactId): string {
  const config = json({ artifact: id, origin: artifactOrigin(id) });
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Viewer ${id}</title></head>
<body>
<h1>Viewer for ${id}</h1>
<iframe id="artifact" title="Artifact" width="800" height="300"
  sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
<p><button id="start" type="button">Let this page save what I enter</button></p>
<div id="control" hidden>
  <p>${id} will learn your display name and an ID for this artifact, never your email. The people who manage it read everything saved there.</p>
  <button id="allow" type="button">Allow</button> <button id="not-now" type="button">Not now</button>
</div>
<p id="unavailable" hidden>Saving is not available in this frame. <a id="open-tab" href="${artifactOrigin(id)}/" target="_blank" rel="noopener">Open the artifact in a new tab</a></p>
<script>
const config = ${config};
const frame = document.getElementById("artifact");
let nonceHash = null;
window.viewerEvents = [];
frame.src = config.origin + "/";
document.getElementById("start").addEventListener("click", () => {
  frame.src = config.origin + "/__portifact/data/grant/begin?flow=frame";
});
window.addEventListener("message", (event) => {
  if (event.origin !== config.origin || event.source !== frame.contentWindow) return;
  const data = event.data || {};
  window.viewerEvents.push(String(data.type));
  if (data.type === "grant-begin" && typeof data.nonceHash === "string") {
    nonceHash = data.nonceHash;
    document.getElementById("control").hidden = false;
  }
  if (data.type === "grant-unavailable") document.getElementById("unavailable").hidden = false;
});
document.getElementById("allow").addEventListener("click", async () => {
  document.getElementById("control").hidden = true;
  const response = await fetch("/api/data/grant-codes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifact: config.artifact, nonceHash }),
  });
  const { code } = await response.json();
  frame.src = config.origin + "/__portifact/data/grant?flow=frame&code=" + encodeURIComponent(code);
});
</script>
</body>
</html>`;
}

/** The consent control for the top-level flows, drawn by the app. */
export function consentPage(name: string | null, host: string, nonceHash: string): string {
  if (name === null)
    return `<!doctype html><title>Sign in</title><p id="signin">Sign in to continue.</p>`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Allow ${escapeHtml(host)}</title></head>
<body>
<h1>Let ${escapeHtml(host)} save what you enter?</h1>
<p>It will know you as ${escapeHtml(name)} with an ID for this artifact, never your email.</p>
<form method="post" action="${APP_ORIGIN}/data/consent">
  <input type="hidden" name="host" value="${escapeHtml(host)}">
  <input type="hidden" name="nonceHash" value="${escapeHtml(nonceHash)}">
  <button id="allow" type="submit">Allow</button>
</form>
<p><a id="not-now" href="https://${escapeHtml(host)}/">Not now</a></p>
</body>
</html>`;
}

/** A Portifact page on the artifact origin that posts one message to its parent or opener. */
export function messagePage(message: unknown, to: "parent", origin: string): string {
  return `<!doctype html><title>Portifact</title><script>
window.${to}.postMessage(${json(message)}, ${json(origin)});
</script>`;
}

/**
 * The artifact: its own script asks `me`, writes a note, and starts the direct-visit flow in the
 * same tab or in a popup. Every helper is on `window.spike` for the tests.
 */
export function artifactPage(id: ArtifactId): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${id}</title></head>
<body>
<h1>${id}</h1>
<button id="save-here" type="button">Save with my name (this tab)</button>
<button id="save-popup" type="button">Save with my name (popup)</button>
<script>
window.spike = {
  ready: true,
  popupGranted: false,
  async me() {
    const response = await fetch("/__portifact/data/me");
    return { status: response.status, body: await response.text() };
  },
  async write(text) {
    const response = await fetch("/__portifact/data/c/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return { status: response.status, body: await response.text() };
  },
};
document.getElementById("save-here").addEventListener("click", () => {
  location.href = "/__portifact/data/grant/begin?flow=popup";
});
document.getElementById("save-popup").addEventListener("click", () => {
  window.open("/__portifact/data/grant/begin?flow=popup", "grant", "popup");
});
window.addEventListener("message", (event) => {
  if (event.origin === location.origin && event.data && event.data.type === "granted") window.spike.popupGranted = true;
});
</script>
</body>
</html>`;
}
