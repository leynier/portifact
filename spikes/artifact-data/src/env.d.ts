declare namespace Cloudflare {
  interface Env {
    DOCUMENTS: DurableObjectNamespace<import("./documents.ts").ArtifactDocuments>;
    SANDBOX: DurableObjectNamespace<import("./sandbox.ts").ArtifactSandbox>;
    LEDGER: DurableObjectNamespace<import("./ledger.ts").OwnerLedger>;
    /** The second Worker of the spike, which binds the documents class by `script_name`. */
    APP: Fetcher;
  }
}

type Env = Cloudflare.Env;
