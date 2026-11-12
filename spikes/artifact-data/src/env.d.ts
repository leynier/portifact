declare namespace Cloudflare {
  interface Env {
    ARTIFACT_DATA: DurableObjectNamespace<import("./artifact-data.ts").ArtifactData>;
    /** The second Worker of the spike, which binds the class by `script_name`. */
    APP: Fetcher;
  }
}

type Env = Cloudflare.Env;
