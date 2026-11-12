// The account export's address and file name, shared by the server's Content-Disposition and the
// links that save it (the Settings page, the "Download your data" page and the login page's review
// screen). The links carry the name in their `download` attribute: without the attribute WebKit
// shows the JSON in the tab (personal data on screen and in the history), and with an empty one it
// names the file after the URL. When both name it, Chromium and Firefox take the header's name and
// WebKit the attribute's, so both must have this format; they differ only if the browser's UTC
// date differs from the server's.

export const ACCOUNT_EXPORT_PATH = "/api/v1/account/export";

/** `portifact-export-<UTC date>.json` for the moment `now` (epoch milliseconds). */
export function accountExportFileName(now: number): string {
  return `portifact-export-${new Date(now).toISOString().slice(0, 10)}.json`;
}
