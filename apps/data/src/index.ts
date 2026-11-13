// The data Worker of decision 0026 (`portifact-data`): it exports the documents Durable Object and
// answers nothing itself. No route, no D1, R2 or queue binding and no secret. The jobs Worker
// reaches the object's lifecycle methods through a binding to this script (`script_name`); the app
// and content Workers bind it with the deliveries that add their callers (owner API, page).
export { ArtifactDocuments } from "./documents.ts";

export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
