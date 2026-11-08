import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BuildCancelled,
  type BuildMessage,
  builderOver,
  handleBuildRequest,
  inProcessBuilder,
  workerBuilder,
} from "./builder.ts";
import { ManifestError } from "./manifest.ts";

afterEach(() => vi.unstubAllGlobals());

const site = (text = "<h1>x</h1>") => ({
  source: { kind: "text" as const, text, fileName: "index.html" },
  options: { type: "site" as const },
});

describe("handleBuildRequest", () => {
  it("posts progress, then the manifest", async () => {
    const messages: BuildMessage[] = [];
    await handleBuildRequest(site(), (m) => messages.push(m));
    expect(messages.at(-1)?.kind).toBe("done");
    expect(messages.slice(0, -1).every((m) => m.kind === "progress")).toBe(true);
  });

  it("posts rule failures with their reason and anything else as unexpected, never throwing", async () => {
    const messages: BuildMessage[] = [];
    await handleBuildRequest(
      { source: { kind: "zip", blob: new Blob(["nope"]) }, options: { type: "site" } },
      (m) => messages.push(m),
    );
    expect(messages).toEqual([{ kind: "error", reason: "not_zip" }]);
    const broken: BuildMessage[] = [];
    await handleBuildRequest({ source: null, options: { type: "site" } } as never, (m) =>
      broken.push(m),
    );
    expect(broken).toEqual([{ kind: "error", reason: "unexpected" }]);
  });
});

describe("builders", () => {
  it("builds in process and reports progress", async () => {
    const onProgress = vi.fn();
    const manifest = await inProcessBuilder.build(site(), onProgress, new AbortController().signal);
    expect(manifest.files.map((f) => f.path)).toEqual(["index.html"]);
    expect(onProgress).toHaveBeenCalled();
  });

  it("turns error messages back into manifest errors", async () => {
    const error = await inProcessBuilder
      .build(
        {
          source: { kind: "text", text: "x", fileName: "a.txt" },
          options: { type: "site" },
        },
        () => {},
        new AbortController().signal,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManifestError);
    expect((error as ManifestError).reason).toBe("missing_entry");
  });

  it("cancels: before starting, and while running, closing the channel", async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(inProcessBuilder.build(site(), () => {}, aborted.signal)).rejects.toBeInstanceOf(
      BuildCancelled,
    );

    const close = vi.fn();
    let listener: (m: BuildMessage) => void = () => {};
    const builder = builderOver(() => ({
      send: () => {},
      onMessage: (next) => {
        listener = next;
      },
      close,
    }));
    const controller = new AbortController();
    const onProgress = vi.fn();
    const running = builder.build(site(), onProgress, controller.signal);
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(BuildCancelled);
    expect(close).toHaveBeenCalledTimes(1);
    listener({
      kind: "progress",
      progress: { doneBytes: 1, totalBytes: 1, doneFiles: 1, totalFiles: 1 },
    });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("runs each build in a Web Worker it terminates afterwards", async () => {
    const workers: FakeWorker[] = [];
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      terminated = false;
      constructor(
        readonly url: URL,
        readonly options: WorkerOptions,
      ) {
        workers.push(this);
      }
      postMessage(request: unknown) {
        void handleBuildRequest(request as never, (message) =>
          this.onmessage?.({ data: message } as MessageEvent),
        );
      }
      terminate() {
        this.terminated = true;
      }
    }
    vi.stubGlobal("Worker", FakeWorker);
    const builder = workerBuilder();
    const manifest = await builder.build(site(), () => {}, new AbortController().signal);
    expect(manifest.entrypoint).toBe("index.html");
    expect(workers).toHaveLength(1);
    expect(workers[0]?.url.pathname).toMatch(/worker\.ts$/);
    expect(workers[0]?.options).toEqual({ type: "module" });
    expect(workers[0]?.terminated).toBe(true);

    const failing = builder.build(site(), () => {}, new AbortController().signal);
    workers[1]?.onerror?.();
    await expect(failing).rejects.toMatchObject({ reason: "unexpected" });
  });

  it("falls back to building in process where workers are unavailable", () => {
    vi.stubGlobal("Worker", undefined);
    expect(workerBuilder()).toBe(inProcessBuilder);
  });
});
