// Every test starts without cookies. The language and theme preferences live in cookies shared
// by the site and the app (`@portifact/contracts/preferences`), and a DOM environment keeps
// `document.cookie` for the whole file, so a choice made in one test would leak into the next.
import { configure } from "@testing-library/react";
import { beforeEach } from "vitest";

// `findBy` and `waitFor` give up after one second by default. CI runs every package's tests at
// once on one runner, where a file's first render (it loads the router and the catalogs) has
// taken almost two, so a correct test failed now and then. Like `testTimeout`, this only catches
// hangs: a test that cares about speed asserts its own time budget.
configure({ asyncUtilTimeout: 10_000 });

beforeEach(() => {
  if (typeof document === "undefined") return;
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    // biome-ignore lint/suspicious/noDocumentCookie: the test plays the browser's own cookie jar
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0; Secure`;
  }
});
