// The browser's way to storage: XMLHttpRequest for uploads, because fetch reports no upload
// progress, and fetch for downloads. Both go straight to R2's S3 endpoint, allowed by the
// dashboard's `connect-src` and the bucket's CORS rule (docs/releasing.md). No credentials or
// API tokens are ever sent there.
import type { StorageTransport } from "./upload.ts";

/**
 * Headers the browser sets itself and refuses from scripts. They are signed too, and the browser
 * sends exactly the values the signature expects: the host of the URL and the size of the body.
 */
const SET_BY_BROWSER = new Set(["host", "content-length"]);

export const xhrTransport: StorageTransport = {
  put(target, body, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(target.method, target.url);
      for (const [name, value] of Object.entries(target.headers)) {
        if (!SET_BY_BROWSER.has(name.toLowerCase())) xhr.setRequestHeader(name, value);
      }
      xhr.upload.onprogress = (event) => onProgress(event.loaded);
      xhr.onload = () => resolve(xhr.status);
      xhr.onerror = () => resolve(0);
      xhr.ontimeout = () => resolve(0);
      const abort = () => xhr.abort();
      xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      xhr.onloadend = () => signal.removeEventListener("abort", abort);
      xhr.send(body);
    });
  },
  async get(url, signal) {
    const response = await fetch(url, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`download failed with ${response.status}`);
    return response.blob();
  },
};
