declare namespace Cloudflare {
  interface Env {
    CONTROL: D1Database;
    ACCESS: D1Database;
    /** A local Analytics Engine binding, only to show what workerd does with it. */
    VIEWS_AE: AnalyticsEngineDataset;
    CONTROL_MIGRATIONS: import("cloudflare:test").D1Migration[];
    ACCESS_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

type Env = Cloudflare.Env;
