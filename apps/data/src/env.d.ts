declare namespace Cloudflare {
  interface Env {
    DOCUMENTS: DurableObjectNamespace<import("./documents.ts").ArtifactDocuments>;
  }
}

type Env = Cloudflare.Env;
