// Web Worker that builds a manifest off the main thread (plan section 6): hashing and ZIP
// expansion run here, incrementally, and only progress and the result go back to the page.
import { handleBuildRequest } from "./builder.ts";

// The project is typed with the DOM library; a dedicated worker's scope has this shape.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
};
scope.onmessage = (event) => {
  void handleBuildRequest(event.data, (message) => scope.postMessage(message));
};
