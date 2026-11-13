// The data Worker of decision 0026 (`portifact-data`): it exports the documents Durable Object and
// answers nothing itself. No route, no D1, R2 or queue binding and no secret: the content, app and
// jobs Workers will reach the object through a binding to this script (`script_name`) in later
// deliveries.
export { ArtifactDocuments } from "./documents.ts";

export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
