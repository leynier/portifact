// Command-line options of the load test (scripts/load-test.ts). Pure, so the production guard
// and the defaults are unit tested.

export const SCENARIOS = ["quota-race", "max-upload", "delivery", "annotations"] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** Domains of the production service. The load test refuses them without an explicit flag. */
export const PRODUCTION_DOMAINS = ["portifact.com", "portifact.dev"] as const;
export const PRODUCTION_FLAG = "--i-know-this-is-production";

export interface LocalTarget {
  kind: "local";
}

export interface RemoteTarget {
  kind: "remote";
  /** Origin of the app Worker, for example https://app.staging.example. */
  appOrigin: string;
  /** Parent domain of artifact origins: an artifact is served at https://<id>.<contentDomain>. */
  contentDomain: string;
}

export interface LoadOptions {
  target: LocalTarget | RemoteTarget;
  scenarios: Scenario[];
  /** Concurrent publishes racing for the last active slot. */
  publishers: number;
  /** Concurrent connections and seconds of the delivery run. */
  concurrency: number;
  durationSeconds: number;
  /** Authors writing at once, and writes each one sends in its burst. */
  authors: number;
  writes: number;
  /** Existing artifact for remote delivery or annotation runs. */
  artifact: string | null;
  json: boolean;
}

export type Parsed = { ok: true; options: LoadOptions } | { ok: false; error: string };

const DEFAULTS = {
  publishers: 8,
  concurrency: 32,
  durationSeconds: 10,
  authors: 4,
  writes: 8,
};

export const USAGE = `Usage: bun run test:load [options]

Targets a local e2e Worker (wrangler, local D1 and R2) unless --app-url is given.

  --scenario <list>       Comma-separated: ${SCENARIOS.join(", ")} (default: all locally;
                          required for a remote target)
  --app-url <url>         Remote app origin, for example a staging deployment
  --content-domain <d>    Remote artifact domain (required with --app-url)
  --artifact <id>         Existing artifact for remote delivery and annotations
  --publishers <n>        Concurrent publishes in quota-race (default ${DEFAULTS.publishers})
  --concurrency <n>       Connections in delivery (default ${DEFAULTS.concurrency})
  --duration <seconds>    Length of delivery (default ${DEFAULTS.durationSeconds})
  --authors <n>           Authors in annotations (default ${DEFAULTS.authors})
  --writes <n>            Writes per author in annotations (default ${DEFAULTS.writes})
  --json                  Print the results as JSON
  ${PRODUCTION_FLAG}
                          Allow portifact.com or portifact.dev (never needed for staging)

A remote target reads its bearer token from PORTIFACT_LOAD_TOKEN (scopes artifacts:write,
artifacts:read and annotations:write), never from the command line.`;

/** True when the host is a production domain or one of its subdomains. */
export function isProductionHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return PRODUCTION_DOMAINS.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

function positive(name: string, value: string | undefined): number | string {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return `${name} needs a positive integer.`;
  return number;
}

export function parseOptions(argv: readonly string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valued = new Set([
    "--scenario",
    "--app-url",
    "--content-domain",
    "--artifact",
    "--publishers",
    "--concurrency",
    "--duration",
    "--authors",
    "--writes",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json" || arg === PRODUCTION_FLAG) {
      flags.add(arg);
    } else if (valued.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return fail(`${arg} needs a value.`);
      values.set(arg, value);
      i++;
    } else {
      return fail(`Unknown option ${arg}.`);
    }
  }

  const numbers: Record<keyof typeof DEFAULTS, number> = { ...DEFAULTS };
  const numeric: [keyof typeof DEFAULTS, string][] = [
    ["publishers", "--publishers"],
    ["concurrency", "--concurrency"],
    ["durationSeconds", "--duration"],
    ["authors", "--authors"],
    ["writes", "--writes"],
  ];
  for (const [key, flag] of numeric) {
    if (!values.has(flag)) continue;
    const parsed = positive(flag, values.get(flag));
    if (typeof parsed === "string") return fail(parsed);
    numbers[key] = parsed;
  }

  const appUrl = values.get("--app-url");
  const contentDomain = values.get("--content-domain");
  let target: LocalTarget | RemoteTarget = { kind: "local" };
  if (appUrl !== undefined || contentDomain !== undefined) {
    if (appUrl === undefined || contentDomain === undefined) {
      return fail("A remote target needs both --app-url and --content-domain.");
    }
    if (!URL.canParse(appUrl) || new URL(appUrl).protocol !== "https:") {
      return fail("--app-url must be an https URL.");
    }
    const domain = contentDomain.toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      return fail("--content-domain must be a domain name, for example staging.example.dev.");
    }
    const appHost = new URL(appUrl).hostname;
    if ((isProductionHost(appHost) || isProductionHost(domain)) && !flags.has(PRODUCTION_FLAG)) {
      return fail(
        `Refusing to load-test production (${appHost}, ${domain}). Target staging, or pass ${PRODUCTION_FLAG} if you really mean it.`,
      );
    }
    target = { kind: "remote", appOrigin: new URL(appUrl).origin, contentDomain: domain };
  }

  const listed = values.get("--scenario");
  let scenarios: Scenario[] = [...SCENARIOS];
  if (listed !== undefined) {
    const names = listed.split(",").map((name) => name.trim());
    const unknown = names.find((name) => !(SCENARIOS as readonly string[]).includes(name));
    if (unknown !== undefined) return fail(`Unknown scenario ${unknown}.`);
    scenarios = [...new Set(names as Scenario[])];
  } else if (target.kind === "remote") {
    return fail("A remote target needs --scenario, so a run never does more than you chose.");
  }

  const artifact = values.get("--artifact") ?? null;
  if (artifact !== null && !/^[a-z2-7]{10}$/.test(artifact)) {
    return fail("--artifact must be an artifact ID.");
  }
  if (target.kind === "remote" && artifact === null) {
    const needs = scenarios.filter((name) => name === "delivery" || name === "annotations");
    if (needs.length > 0) return fail(`${needs.join(" and ")} on a remote target need --artifact.`);
  }

  return {
    ok: true,
    options: { target, scenarios, ...numbers, artifact, json: flags.has("--json") },
  };
}

function fail(error: string): Parsed {
  return { ok: false, error };
}
