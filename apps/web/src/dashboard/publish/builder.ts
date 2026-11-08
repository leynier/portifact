// How the page asks for a manifest. In the browser each build runs in its own Web Worker
// (./worker.ts), which is terminated when the build ends or is cancelled. Tests and browsers
// without workers build in process through the same messages.
import {
  type BrowserManifest,
  buildManifest,
  ManifestError,
  type ManifestErrorReason,
  type ManifestOptions,
  type ManifestProgress,
  type ManifestSource,
} from "./manifest.ts";

export interface BuildRequest {
  source: ManifestSource;
  options: ManifestOptions;
}

export type BuildMessage =
  | { kind: "progress"; progress: ManifestProgress }
  | { kind: "done"; manifest: BrowserManifest }
  | { kind: "error"; reason: ManifestErrorReason | "unexpected"; detail?: string };

export interface ManifestBuilder {
  build(
    request: BuildRequest,
    onProgress: (progress: ManifestProgress) => void,
    signal: AbortSignal,
  ): Promise<BrowserManifest>;
}

/** Runs one build and reports it as messages; never throws. */
export async function handleBuildRequest(
  request: BuildRequest,
  post: (message: BuildMessage) => void,
): Promise<void> {
  try {
    const manifest = await buildManifest(request.source, request.options, (progress) =>
      post({ kind: "progress", progress }),
    );
    post({ kind: "done", manifest });
  } catch (error) {
    post(
      error instanceof ManifestError
        ? { kind: "error", reason: error.reason, ...(error.detail ? { detail: error.detail } : {}) }
        : { kind: "error", reason: "unexpected" },
    );
  }
}

export class BuildCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "BuildCancelled";
  }
}

interface Channel {
  send(request: BuildRequest): void;
  onMessage(listener: (message: BuildMessage) => void): void;
  close(): void;
}

/** Turns the messages of a channel into one build's promise. */
export function builderOver(open: () => Channel): ManifestBuilder {
  return {
    build(request, onProgress, signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new BuildCancelled());
        const channel = open();
        const finish = () => {
          signal.removeEventListener("abort", cancel);
          channel.close();
        };
        const cancel = () => {
          finish();
          reject(new BuildCancelled());
        };
        signal.addEventListener("abort", cancel, { once: true });
        channel.onMessage((message) => {
          if (signal.aborted) return;
          if (message.kind === "progress") return onProgress(message.progress);
          finish();
          if (message.kind === "done") resolve(message.manifest);
          else reject(new ManifestError(message.reason as ManifestErrorReason, message.detail));
        });
        channel.send(request);
      });
    },
  };
}

/** Builds in this thread, through the same messages a worker would send. */
export const inProcessBuilder: ManifestBuilder = builderOver(() => {
  let listener: (message: BuildMessage) => void = () => {};
  let closed = false;
  return {
    send: (request) => {
      void handleBuildRequest(request, (message) => {
        if (!closed) listener(message);
      });
    },
    onMessage: (next) => {
      listener = next;
    },
    close: () => {
      closed = true;
    },
  };
});

/** Builds in a new Web Worker per manifest, or in process where workers are unavailable. */
export function workerBuilder(): ManifestBuilder {
  if (typeof Worker === "undefined") return inProcessBuilder;
  return builderOver(() => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    return {
      send: (request) => worker.postMessage(request),
      onMessage: (listener) => {
        worker.onmessage = (event: MessageEvent<BuildMessage>) => listener(event.data);
        worker.onerror = () => listener({ kind: "error", reason: "unexpected" });
      },
      close: () => worker.terminate(),
    };
  });
}
