declare namespace Cloudflare {
  interface Env {
    DOCUMENTS: DurableObjectNamespace<import("./documents.ts").ArtifactDocuments>;
    /** The region's bucket, for the author journal. */
    JOURNAL: R2Bucket;
    /** The restore drill's stand-in for the main D1 database. */
    MAIN: D1Database;
    /** The second Worker of the spike, which binds the documents class by `script_name`. */
    APP: Fetcher;
  }
}

type Env = Cloudflare.Env;
