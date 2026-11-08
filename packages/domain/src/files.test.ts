import { describe, expect, it } from "vitest";
import {
  baseName,
  contentTypeFor,
  contentTypeOf,
  DEFAULT_ENTRY,
  excludedPrefix,
  exclusionOf,
  extensionOf,
  inferType,
} from "./files.ts";

describe("exclusionOf", () => {
  it("leaves out version control, dependencies, caches and OS clutter in any case", () => {
    for (const name of [
      ".git",
      ".GIT",
      ".Git",
      "node_modules",
      "__pycache__",
      ".turbo",
      ".DS_Store",
      "__MACOSX",
    ]) {
      expect(exclusionOf(name), name).toBe("default");
    }
  });

  it("flags files that may hold secrets", () => {
    for (const name of [
      ".env",
      ".env.local",
      ".ENV.production",
      ".dev.vars",
      ".dev.vars.staging",
      ".npmrc",
      ".netrc",
      "id_rsa",
      "id_ed25519",
      "server.pem",
      "tls.KEY",
      "cert.p12",
      "terraform.tfstate",
      "terraform.tfstate.backup",
      ".ssh",
      ".aws",
    ]) {
      expect(exclusionOf(name), name).toBe("secret");
    }
  });

  it("keeps ordinary files and documented environment templates", () => {
    for (const name of [
      "index.html",
      ".env.example",
      ".env.sample",
      ".env.template",
      ".dev.vars.example",
      "id_rsa.pub",
      "keys.json",
      ".well-known",
      "environment.md",
    ]) {
      expect(exclusionOf(name), name).toBeUndefined();
    }
  });
});

describe("excludedPrefix", () => {
  it("names the first excluded segment of a path and why", () => {
    expect(excludedPrefix("site/.git/config")).toEqual({ path: "site/.git", reason: "default" });
    expect(excludedPrefix("a/node_modules/x/y.js")).toEqual({
      path: "a/node_modules",
      reason: "default",
    });
    expect(excludedPrefix("conf/.env")).toEqual({ path: "conf/.env", reason: "secret" });
  });

  it("is undefined for a path without excluded segments", () => {
    expect(excludedPrefix("site/assets/app.js")).toBeUndefined();
  });
});

describe("baseName and extensionOf", () => {
  it("takes the last segment with either separator", () => {
    expect(baseName("a/b/c.txt")).toBe("c.txt");
    expect(baseName("C:\\x\\Page.HTML")).toBe("Page.HTML");
    expect(baseName("plain")).toBe("plain");
  });

  it("returns the lowercased extension and none for dotfiles", () => {
    expect(extensionOf("a/INDEX.HTML")).toBe(".html");
    expect(extensionOf("archive.tar.gz")).toBe(".gz");
    expect(extensionOf(".env")).toBe("");
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf("dir.d/file")).toBe("");
  });
});

describe("contentTypeOf, contentTypeFor and inferType", () => {
  it("maps known extensions in any case and falls back to octet-stream", () => {
    expect(contentTypeOf("a/INDEX.HTML")).toBe("text/html; charset=utf-8");
    expect(contentTypeOf("app.mjs")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeOf("font.woff2")).toBe("font/woff2");
    expect(contentTypeOf("Makefile")).toBe("application/octet-stream");
    expect(contentTypeOf("data.bin")).toBe("application/octet-stream");
  });

  it("declares documents with their own type whatever the extension", () => {
    expect(contentTypeFor("markdown", "notes.txt")).toBe("text/markdown; charset=utf-8");
    expect(contentTypeFor("text", "page.html")).toBe("text/plain; charset=utf-8");
    expect(contentTypeFor("site", "page.html")).toBe("text/html; charset=utf-8");
  });

  it("treats folders as sites and files by extension", () => {
    expect(inferType("/x/dist", true)).toBe("site");
    expect(inferType("/x/page.htm", false)).toBe("site");
    expect(inferType("/x/plan.markdown", false)).toBe("markdown");
    expect(inferType("/x/notes.txt", false)).toBe("text");
    expect(inferType("/x/data.csv", false)).toBeUndefined();
    expect(DEFAULT_ENTRY).toBe("index.html");
  });
});
