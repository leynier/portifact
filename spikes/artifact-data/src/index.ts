// The spike's data Worker (decision 0026): it exports the documents object, the owner's ledger
// and, for the spike only, the SQL sandbox (production gives the sandbox a Worker of its own,
// `portifact-sql`, so its CPU limit and isolates are separate from the documents').
export { ArtifactDocuments } from "./documents.ts";
export { OwnerLedger } from "./ledger.ts";
export { ArtifactSandbox } from "./sandbox.ts";

export default {
  fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler;
