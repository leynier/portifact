import { createHash } from "node:crypto";
import { LIMITS } from "@portifact/contracts";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  buildManifest,
  ManifestError,
  type ManifestProgress,
  type ManifestSource,
} from "./manifest.ts";

const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

function folder(entries: Record<string, string>): ManifestSource {
  return {
    kind: "files",
    folder: true,
    files: Object.entries(entries).map(([path, text]) => ({ path, blob: new Blob([text]) })),
  };
}

function zipOf(entries: Record<string, string>): ManifestSource {
  const files = Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)]));
  return { kind: "zip", blob: new Blob([zipSync(files) as BlobPart]) };
}

async function failure(promise: Promise<unknown>): Promise<ManifestError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ManifestError);
  return error as ManifestError;
}

describe("buildManifest for sites", () => {
  it("publishes a picked folder's contents with hashes, sizes and content types", async () => {
    const manifest = await buildManifest(
      folder({
        "report/index.html": "<h1>Hi</h1>",
        "report/assets/app.js": "1",
        "report/assets/logo.svg": "<svg/>",
      }),
      { type: "site" },
    );
    expect(manifest.entrypoint).toBe("index.html");
    expect(manifest.files.map(({ blob: _, ...file }) => file)).toEqual([
      {
        path: "index.html",
        size: 11,
        sha256: sha("<h1>Hi</h1>"),
        contentType: "text/html; charset=utf-8",
      },
      {
        path: "assets/app.js",
        size: 1,
        sha256: sha("1"),
        contentType: "text/javascript; charset=utf-8",
      },
      { path: "assets/logo.svg", size: 6, sha256: sha("<svg/>"), contentType: "image/svg+xml" },
    ]);
    expect(manifest.totalBytes).toBe(18);
    expect(manifest.excluded).toEqual([]);
  });

  it("leaves out version control, dependencies and secrets like the CLI, listing each folder once", async () => {
    const manifest = await buildManifest(
      folder({
        "site/index.html": "x",
        "site/.git/config": "[core]",
        "site/.git/HEAD": "ref",
        "site/node_modules/a/index.js": "a",
        "site/.env": "TOKEN=1",
        "site/.env.example": "TOKEN=",
        "site/keys/server.pem": "-----",
      }),
      { type: "site" },
    );
    expect(manifest.files.map((f) => f.path)).toEqual(["index.html", ".env.example"]);
    expect(manifest.excluded).toEqual([
      { path: ".git", reason: "default" },
      { path: "node_modules", reason: "default" },
      { path: ".env", reason: "secret" },
      { path: "keys/server.pem", reason: "secret" },
    ]);
  });

  it("stores a single picked page as the entry page and keeps several picked files side by side", async () => {
    const single = await buildManifest(
      { kind: "files", folder: false, files: [{ path: "Report.HTML", blob: new Blob(["<p>"]) }] },
      { type: "site", entry: "home.html" },
    );
    expect(single.files.map((f) => f.path)).toEqual(["home.html"]);
    expect(single.entrypoint).toBe("home.html");

    const several = await buildManifest(
      {
        kind: "files",
        folder: false,
        files: [
          { path: "index.html", blob: new Blob(["a"]) },
          { path: "style.css", blob: new Blob(["b"]) },
        ],
      },
      { type: "site" },
    );
    expect(several.files.map((f) => f.path)).toEqual(["index.html", "style.css"]);
  });

  it("expands a ZIP of a folder into its contents", async () => {
    const manifest = await buildManifest(
      zipOf({ "dist/index.html": "<h1>Zip</h1>", "dist/a/b.css": "b{}", "dist/.DS_Store": "x" }),
      { type: "site" },
    );
    expect(manifest.files.map((f) => [f.path, f.sha256])).toEqual([
      ["index.html", sha("<h1>Zip</h1>")],
      ["a/b.css", sha("b{}")],
    ]);
    expect(await manifest.files[0]?.blob.text()).toBe("<h1>Zip</h1>");
    expect(manifest.excluded).toEqual([{ path: ".DS_Store", reason: "default" }]);
  });

  it("keeps paths as they are when the ZIP has several top-level entries", async () => {
    const manifest = await buildManifest(zipOf({ "index.html": "i", "docs/a.html": "a" }), {
      type: "site",
    });
    expect(manifest.files.map((f) => f.path)).toEqual(["index.html", "docs/a.html"]);
  });

  it("refuses ZIP entries that escape the root, collide or are links", async () => {
    expect(
      (
        await failure(
          buildManifest(zipOf({ "index.html": "i", "../evil.html": "e" }), { type: "site" }),
        )
      ).reason,
    ).toBe("invalid_path");
    const collide = await failure(
      buildManifest(zipOf({ "index.html": "i", "INDEX.html": "j" }), { type: "site" }),
    );
    expect(collide.reason).toBe("invalid_path");
    expect(collide.detail).toContain("collides");
    const link = zipSync({
      "index.html": strToU8("i"),
      link: [strToU8("/etc/passwd"), { os: 3, attrs: 0o120777 << 16 }],
    });
    const linkError = await failure(
      buildManifest({ kind: "zip", blob: new Blob([link as BlobPart]) }, { type: "site" }),
    );
    expect(linkError.reason).toBe("symlink");
    expect(linkError.detail).toBe("link");
    expect(
      (await failure(buildManifest({ kind: "zip", blob: new Blob(["no zip"]) }, { type: "site" })))
        .reason,
    ).toBe("not_zip");
  });

  it("refuses a site without its entry page, or with an invalid entry page", async () => {
    const missing = await failure(
      buildManifest(folder({ "s/about.html": "a", "s/x.css": "" }), { type: "site" }),
    );
    expect(missing.reason).toBe("missing_entry");
    expect(missing.detail).toBe("index.html");
    expect(
      (
        await failure(
          buildManifest(folder({ "s/a.html": "a", "s/b": "" }), {
            type: "site",
            entry: "../a.html",
          }),
        )
      ).reason,
    ).toBe("invalid_path");
    const custom = await buildManifest(folder({ "s/about.html": "a", "s/b.css": "" }), {
      type: "site",
      entry: " about.html ",
    });
    expect(custom.entrypoint).toBe("about.html");
  });

  it("refuses sources with nothing left to publish", async () => {
    expect(
      (await failure(buildManifest(folder({ "s/.git/HEAD": "x" }), { type: "site" }))).reason,
    ).toBe("empty");
  });

  it("refuses more files than a version holds before hashing anything", async () => {
    const files = Array.from({ length: LIMITS.filesPerVersion + 1 }, (_, i) => ({
      path: `s/f${i}.txt`,
      blob: new Blob(["x"]),
    }));
    const onProgress = vi.fn();
    const error = await failure(
      buildManifest({ kind: "files", folder: true, files }, { type: "site" }, onProgress),
    );
    expect(error.reason).toBe("too_many_files");
    expect(onProgress).not.toHaveBeenCalled();
    const atLimit = files.slice(0, LIMITS.filesPerVersion - 1);
    atLimit.push({ path: "s/index.html", blob: new Blob(["i"]) });
    expect(
      (await buildManifest({ kind: "files", folder: true, files: atLimit }, { type: "site" }))
        .files,
    ).toHaveLength(LIMITS.filesPerVersion);
  });

  it("refuses a ZIP that declares more than a version holds before expanding it", async () => {
    const bytes = zipSync({ "index.html": strToU8("x") });
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < bytes.length - 4; i++) {
      // The uncompressed size in the central directory entry.
      if (view.getUint32(i, true) === 0x02014b50)
        view.setUint32(i + 24, LIMITS.artifactBytes + 1, true);
    }
    const error = await failure(
      buildManifest({ kind: "zip", blob: new Blob([bytes as BlobPart]) }, { type: "site" }),
    );
    expect(error.reason).toBe("too_large");
  });

  it("reports hashing progress up to the total", async () => {
    const seen: ManifestProgress[] = [];
    await buildManifest(folder({ "s/index.html": "abc", "s/b.css": "de" }), { type: "site" }, (p) =>
      seen.push(p),
    );
    expect(seen[0]).toEqual({ doneBytes: 0, totalBytes: 5, doneFiles: 0, totalFiles: 2 });
    expect(seen.at(-1)).toEqual({ doneBytes: 5, totalBytes: 5, doneFiles: 2, totalFiles: 2 });
  });
});

describe("buildManifest for documents", () => {
  it("publishes pasted Markdown under its file name with the document's content type", async () => {
    const manifest = await buildManifest(
      { kind: "text", text: "# Plan\n\nÉtape", fileName: "document.md" },
      { type: "markdown" },
    );
    expect(manifest.entrypoint).toBe("document.md");
    expect(manifest.files.map(({ blob: _, ...f }) => f)).toEqual([
      {
        path: "document.md",
        size: new TextEncoder().encode("# Plan\n\nÉtape").length,
        sha256: sha("# Plan\n\nÉtape"),
        contentType: "text/markdown; charset=utf-8",
      },
    ]);
  });

  it("declares a picked text file as plain text whatever its extension", async () => {
    const manifest = await buildManifest(
      { kind: "files", folder: false, files: [{ path: "notes.html", blob: new Blob(["<b>"]) }] },
      { type: "text" },
    );
    expect(manifest.files[0]?.contentType).toBe("text/plain; charset=utf-8");
    expect(manifest.entrypoint).toBe("notes.html");
  });

  it("refuses several files, binary data and invalid UTF-8", async () => {
    expect(
      (
        await failure(
          buildManifest(
            {
              kind: "files",
              folder: false,
              files: [
                { path: "a.md", blob: new Blob(["a"]) },
                { path: "b.md", blob: new Blob(["b"]) },
              ],
            },
            { type: "markdown" },
          ),
        )
      ).reason,
    ).toBe("document_files");
    const binary = {
      kind: "files",
      folder: false,
      files: [{ path: "a.txt", blob: new Blob([new Uint8Array([104, 0, 105])]) }],
    } as const;
    expect((await failure(buildManifest(binary, { type: "text" }))).reason).toBe("not_text");
    const latin1 = {
      kind: "files",
      folder: false,
      files: [{ path: "a.txt", blob: new Blob([new Uint8Array([0xe9, 0x41])]) }],
    } as const;
    expect((await failure(buildManifest(latin1, { type: "text" }))).reason).toBe("not_text");
  });

  it("refuses documents over 5 MB and accepts one at the limit", async () => {
    const atLimit = "a".repeat(LIMITS.documentBytes);
    const ok = await buildManifest(
      { kind: "text", text: atLimit, fileName: "big.txt" },
      { type: "text" },
    );
    expect(ok.totalBytes).toBe(LIMITS.documentBytes);
    const over = await failure(
      buildManifest({ kind: "text", text: `${atLimit}b`, fileName: "big.txt" }, { type: "text" }),
    );
    expect(over.reason).toBe("document_too_large");
  });
});
