import { describe, expect, it } from "vitest";
import { readConfig } from "./config.ts";

const TAG = "Ses5ionTag_0123456789-";

describe("bridge settings", () => {
  it("reads the viewer origin, path and renderer from the script's data attributes", () => {
    expect(
      readConfig({
        appOrigin: "https://app.portifact.com",
        path: "docs/index.html",
        renderer: "portifact-render@1",
        sessionTag: TAG,
      }),
    ).toEqual({
      appOrigin: "https://app.portifact.com",
      path: "docs/index.html",
      renderer: "portifact-render@1",
      sessionTag: TAG,
    });
    expect(
      readConfig({ appOrigin: "https://app.portifact.com", path: "index.html", sessionTag: TAG }),
    ).toEqual({
      appOrigin: "https://app.portifact.com",
      path: "index.html",
      sessionTag: TAG,
    });
  });

  it("refuses missing or malformed settings", () => {
    for (const data of [
      {},
      { appOrigin: "https://app.portifact.com", sessionTag: TAG },
      { path: "index.html", sessionTag: TAG },
      { appOrigin: "https://app.portifact.com", path: "index.html" },
      { appOrigin: "https://app.portifact.com", path: "index.html", sessionTag: "short" },
      { appOrigin: "https://app.portifact.com", path: "index.html", sessionTag: `${TAG}"` },
      { appOrigin: "not a url", path: "index.html", sessionTag: TAG },
      { appOrigin: "https://app.portifact.com/", path: "index.html", sessionTag: TAG },
      { appOrigin: "https://app.portifact.com/x", path: "index.html", sessionTag: TAG },
      { appOrigin: "https://app.portifact.com", path: "../index.html", sessionTag: TAG },
      {
        appOrigin: "https://app.portifact.com",
        path: "index.html",
        renderer: "<script>",
        sessionTag: TAG,
      },
    ]) {
      expect(readConfig(data)).toBeNull();
    }
  });
});

describe("the edit switch", () => {
  const base = {
    appOrigin: "https://app.portifact.com",
    path: "index.html",
    sessionTag: "Ses5ionTag_0123456789-",
  };

  it("turns protocol 3 on only for the exact value the content Worker writes", () => {
    expect(readConfig({ ...base, edit: "true" })?.edit).toBe(true);
    for (const edit of [undefined, "", "1", "TRUE", "false"]) {
      expect(readConfig({ ...base, edit })).not.toHaveProperty("edit");
    }
  });
});
