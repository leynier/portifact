// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import type { VersionDownload } from "@portifact/contracts";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadFailure, downloadVersion, safeFileName, zipFiles } from "./download.ts";
import { saveFile } from "./save.ts";
import { xhrTransport } from "./transport.ts";
import type { StorageTransport } from "./upload.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function plan(files: Record<string, string>, versionNumber = 3): VersionDownload {
  return {
    artifactId: "abcdefghij",
    versionId: "v3",
    versionNumber,
    kind: "published",
    entrypoint: "index.html",
    files: Object.entries(files).map(([path, text]) => ({
      path,
      sha256: sha(text),
      size: new TextEncoder().encode(text).length,
      contentType: "text/html",
      method: "GET",
      url: `https://storage.test/${encodeURIComponent(path)}`,
      expiresAt: "2026-11-08T12:05:00.000Z",
    })),
  };
}

function storageOf(files: Record<string, string>, override: Record<string, string> = {}) {
  const transport: StorageTransport = {
    put: () => Promise.reject(new Error("unused")),
    get: async (url) => {
      const path = decodeURIComponent(new URL(url).pathname.slice(1));
      if (path === "offline") throw new TypeError("Failed to fetch");
      return new Blob([override[path] ?? files[path] ?? ""]);
    },
  };
  return transport;
}

describe("downloadVersion", () => {
  it("hands over a single file as itself, after checking it", async () => {
    const files = { "docs/plan.md": "# Plan" };
    const onProgress = vi.fn();
    const saved = await downloadVersion({
      api: { versionDownload: async () => plan(files) },
      transport: storageOf(files),
      artifactId: "abcdefghij",
      versionId: "v3",
      kind: "published",
      name: "Plan",
      onProgress,
    });
    expect(saved.fileName).toBe("plan.md");
    expect(await saved.blob.text()).toBe("# Plan");
    expect(onProgress).toHaveBeenLastCalledWith(1, 1);
  });

  it("packages several files into a ZIP named after the artifact and version", async () => {
    const files = { "index.html": "<h1>a</h1>", "assets/app.js": "1" };
    const versionDownload = vi.fn(async () => ({ ...plan(files, 7), kind: "source" as const }));
    const saved = await downloadVersion({
      api: { versionDownload },
      transport: storageOf(files),
      artifactId: "abcdefghij",
      versionId: "v7",
      kind: "source",
      name: "Q3: report?",
    });
    expect(versionDownload).toHaveBeenCalledWith("abcdefghij", "v7", "source");
    expect(saved.fileName).toBe("Q3- report-v7-sources.zip");
    const unzipped = unzipSync(new Uint8Array(await saved.blob.arrayBuffer()));
    expect(Object.keys(unzipped)).toEqual(["index.html", "assets/app.js"]);
    expect(new TextDecoder().decode(unzipped["index.html"])).toBe("<h1>a</h1>");
  });

  it("refuses bytes that do not match the manifest and links that fail", async () => {
    const files = { "index.html": "<h1>a</h1>" };
    const tampered = await downloadVersion({
      api: { versionDownload: async () => plan(files) },
      transport: storageOf(files, { "index.html": "<h1>b</h1>" }),
      artifactId: "abcdefghij",
      versionId: "v3",
      kind: "published",
      name: "x",
    }).catch((e: unknown) => e);
    expect(tampered).toEqual(new DownloadFailure("integrity", "index.html"));
    const offline = await downloadVersion({
      api: { versionDownload: async () => plan({ offline: "x" }) },
      transport: storageOf({}),
      artifactId: "abcdefghij",
      versionId: "v3",
      kind: "published",
      name: "x",
    }).catch((e: unknown) => e);
    expect(offline).toEqual(new DownloadFailure("network", "offline"));
  });

  it("makes safe file names", () => {
    expect(safeFileName("  ../../etc/passwd ")).toBe("etc-passwd");
    expect(safeFileName("...")).toBe("artifact");
    expect(safeFileName("a".repeat(100))).toHaveLength(80);
    expect(safeFileName("Résumé")).toBe("Résumé");
  });

  it("zips an empty list into a valid empty archive", async () => {
    const blob = await zipFiles([]);
    expect(unzipSync(new Uint8Array(await blob.arrayBuffer()))).toEqual({});
  });
});

describe("saveFile", () => {
  it("downloads through a temporary link and releases the object URL later", () => {
    vi.useFakeTimers();
    const create = vi.fn(() => "blob:https://app.portifact.com/1");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    saveFile({ fileName: "plan.zip", blob: new Blob(["x"]) });
    expect(clicked[0]?.download).toBe("plan.zip");
    expect(clicked[0]?.getAttribute("href")).toBe("blob:https://app.portifact.com/1");
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith("blob:https://app.portifact.com/1");
    vi.useRealTimers();
  });
});

describe("xhrTransport", () => {
  class FakeXhr {
    static last: FakeXhr | undefined;
    method = "";
    url = "";
    headers: Record<string, string> = {};
    status = 0;
    body: unknown;
    upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    onloadend: (() => void) | null = null;
    constructor() {
      FakeXhr.last = this;
    }
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send(body: unknown) {
      this.body = body;
    }
    abort() {
      this.onabort?.();
      this.onloadend?.();
    }
  }

  const uploadTarget = {
    sha256: "a".repeat(64),
    size: 3,
    method: "PUT" as const,
    url: "https://acct.r2.cloudflarestorage.com/bucket/objects/u/a?X-Amz-Signature=s",
    headers: { "content-length": "3", Host: "acct", "x-amz-checksum-sha256": "q83v" },
    expiresAt: "2026-11-08T12:15:00.000Z",
  };

  it("sends the signed headers except those the browser sets, and reports progress and status", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const onProgress = vi.fn();
    const body = new Blob(["abc"]);
    const sending = xhrTransport.put(uploadTarget, body, onProgress, new AbortController().signal);
    const xhr = FakeXhr.last as FakeXhr;
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe(uploadTarget.url);
    expect(xhr.headers).toEqual({ "x-amz-checksum-sha256": "q83v" });
    expect(xhr.body).toBe(body);
    xhr.upload.onprogress?.({ loaded: 2 });
    expect(onProgress).toHaveBeenCalledWith(2);
    xhr.status = 200;
    xhr.onload?.();
    expect(await sending).toBe(200);
  });

  it("reports unreachable storage as status 0 and rejects when aborted", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const failing = xhrTransport.put(
      uploadTarget,
      new Blob(["abc"]),
      () => {},
      new AbortController().signal,
    );
    FakeXhr.last?.onerror?.();
    expect(await failing).toBe(0);
    const timing = xhrTransport.put(
      uploadTarget,
      new Blob(["abc"]),
      () => {},
      new AbortController().signal,
    );
    FakeXhr.last?.ontimeout?.();
    expect(await timing).toBe(0);
    const controller = new AbortController();
    const aborted = xhrTransport.put(uploadTarget, new Blob(["abc"]), () => {}, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
  });

  it("downloads without credentials or referrer, and fails on errors", async () => {
    const fetch = vi.fn(async () => new Response("bytes"));
    vi.stubGlobal("fetch", fetch);
    const blob = await xhrTransport.get("https://storage.test/a");
    expect(await blob.text()).toBe("bytes");
    expect(fetch).toHaveBeenCalledWith("https://storage.test/a", {
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    fetch.mockResolvedValueOnce(new Response("no", { status: 403 }));
    const signal = new AbortController().signal;
    await expect(xhrTransport.get("https://storage.test/b", signal)).rejects.toThrow("403");
    expect(fetch).toHaveBeenLastCalledWith(
      "https://storage.test/b",
      expect.objectContaining({ signal }),
    );
  });
});
