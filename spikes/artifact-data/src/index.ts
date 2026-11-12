// The spike's data Worker (decision 0026): it exports the one Durable Object class and serves
// nothing itself. The content, app and jobs Workers bind the class by `script_name`.
export { ArtifactData } from "./artifact-data.ts";

export default {
  fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler;
