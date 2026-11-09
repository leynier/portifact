// Entry of the diagram runner in the diagram script: the Mermaid build before it defines
// `globalThis.mermaid`. Without it (the build failed to load) the source blocks stay as they are.
import { type Mermaid, pageHost, renderDiagrams } from "./diagrams.ts";

const mermaid = (globalThis as { mermaid?: Mermaid }).mermaid;
if (mermaid) void renderDiagrams(pageHost(window, mermaid));
