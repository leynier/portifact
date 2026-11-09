// Every test starts without cookies. The language and theme preferences live in cookies shared
// by the site and the app (`@portifact/contracts/preferences`), and a DOM environment keeps
// `document.cookie` for the whole file, so a choice made in one test would leak into the next.
import { beforeEach } from "vitest";

beforeEach(() => {
  if (typeof document === "undefined") return;
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    // biome-ignore lint/suspicious/noDocumentCookie: the test plays the browser's own cookie jar
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0; Secure`;
  }
});
