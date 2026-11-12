declare namespace Cloudflare {
  interface Env {
    DOCUMENTS: DurableObjectNamespace<import("./documents.ts").ArtifactDocuments>;
    LEDGER: DurableObjectNamespace<import("./ledger.ts").OwnerLedger>;
    /** The region's bucket, for the author journal. */
    JOURNAL: R2Bucket;
    /** The second Worker of the spike, which binds the documents class by `script_name`. */
    APP: Fetcher;
  }
}

type Env = Cloudflare.Env;
