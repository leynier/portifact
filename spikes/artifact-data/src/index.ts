// The spike's data Worker (decision 0026): it exports the documents object and serves nothing
// itself.
export { ArtifactDocuments } from "./documents.ts";

export default {
  fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler;
