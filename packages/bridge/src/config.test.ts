import { describe, expect, it } from "vitest";
import { readConfig } from "./config.ts";

describe("bridge settings", () => {
  it("reads the viewer origin, path and renderer from the script's data attributes", () => {
    expect(
      readConfig({
        appOrigin: "https://app.portifact.com",
        path: "docs/index.html",
        renderer: "portifact-render@1",
      }),
    ).toEqual({
      appOrigin: "https://app.portifact.com",
      path: "docs/index.html",
      renderer: "portifact-render@1",
    });
    expect(readConfig({ appOrigin: "https://app.portifact.com", path: "index.html" })).toEqual({
      appOrigin: "https://app.portifact.com",
      path: "index.html",
    });
  });

  it("refuses missing or malformed settings", () => {
    for (const data of [
      {},
      { appOrigin: "https://app.portifact.com" },
      { path: "index.html" },
      { appOrigin: "not a url", path: "index.html" },
      { appOrigin: "https://app.portifact.com/", path: "index.html" },
      { appOrigin: "https://app.portifact.com/x", path: "index.html" },
      { appOrigin: "https://app.portifact.com", path: "../index.html" },
      { appOrigin: "https://app.portifact.com", path: "index.html", renderer: "<script>" },
    ]) {
      expect(readConfig(data)).toBeNull();
    }
  });
});
