// The two outside services custom domains call (decision 0006): Cloudflare for SaaS custom
// hostnames on the content zone, and TXT lookups over DNS over HTTPS. Everything goes through
// `DomainDeps`, injected into the services, so tests and the e2e stack use `FakeDomains` and never
// reach Cloudflare. `domainDepsFromEnv` builds the real ones only when a deployment switched the
// feature on and holds the token; otherwise custom domains are unavailable and nothing calls out.

import { cnameTarget } from "@portifact/contracts";
import type { CloudflareStatus } from "@portifact/domain";
import { CodedError, logEvent } from "@portifact/domain";

const API = "https://api.cloudflare.com/client/v4";
const DOH = "https://cloudflare-dns.com/dns-query";

/** Cloudflare's custom hostnames API on one zone, reduced to what Portifact needs. */
export interface CustomHostnames {
  create(hostname: string): Promise<{ id: string }>;
  status(id: string): Promise<CloudflareStatus>;
  remove(id: string): Promise<void>;
  list(): Promise<{ id: string; hostname: string }[]>;
}

/** TXT strings at a name, from a resolver Portifact does not run. */
export type TxtLookup = (name: string) => Promise<string[]>;

/**
 * Whether a name is the apex of its own DNS zone (it answers its own SOA record), which cannot
 * hold the CNAME Cloudflare for SaaS needs. Throws when DNS could not be asked.
 */
export type ZoneApexLookup = (hostname: string) => Promise<boolean>;

/**
 * Whether a hostname resolves to Portifact's CNAME target: its CNAME chain names the target, or
 * the addresses it resolves to are among the target's. Throws when DNS could not be asked.
 */
export type PointingLookup = (hostname: string) => Promise<boolean>;

export interface DomainDeps {
  hostnames: CustomHostnames;
  txt: TxtLookup;
  apex: ZoneApexLookup;
  pointing: PointingLookup;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A Cloudflare error without the token or the request: the status and Cloudflare's codes. */
/** A failed call to Cloudflare's custom hostnames API: its status and Cloudflare's error codes. */
export class CloudflareError extends CodedError {
  constructor(
    override readonly status: number,
    readonly codes: number[],
  ) {
    super("CF_HOSTNAMES_HTTP", status, codes);
  }
}

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number }[];
  result_info?: { total_pages?: number };
}

const ZONE_ID = /^[0-9a-f]{32}$/;
const HOSTNAME_ID = /^[0-9a-f-]{1,64}$/;

/**
 * Custom hostnames on the content zone, with a token that holds only "SSL and Certificates Edit"
 * on that zone. The token goes only in the `authorization` header and is never logged; errors
 * carry Cloudflare's status and codes only.
 */
export function cloudflareHostnames(
  fetcher: Fetch,
  zoneId: string,
  token: string,
): CustomHostnames {
  if (!ZONE_ID.test(zoneId)) throw new Error("CF_CONTENT_ZONE_ID is not a zone ID");
  const call = async <T>(path: string, init: RequestInit = {}): Promise<Envelope<T> | null> => {
    const response = await fetcher(`${API}/zones/${zoneId}/custom_hostnames${path}`, {
      ...init,
      redirect: "manual",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    if (response.status === 404) return null;
    let body: Envelope<T> | null = null;
    try {
      body = (await response.json()) as Envelope<T>;
    } catch {
      body = null;
    }
    if (!response.ok || !body?.success) {
      throw new CloudflareError(
        response.status,
        (body?.errors ?? []).map((e) => e.code),
      );
    }
    return body;
  };
  const idPath = (id: string) => {
    if (!HOSTNAME_ID.test(id)) throw new Error("Not a custom hostname ID");
    return `/${id}`;
  };
  return {
    async create(hostname) {
      // HTTP DCV: Portifact creates the hostname only after its own TXT proof, when the
      // customer's CNAME is already in place, so the certificate validates without a record.
      const body = await call<{ id: string }>("", {
        method: "POST",
        body: JSON.stringify({ hostname, ssl: { method: "http", type: "dv" } }),
      });
      if (!body) throw new CloudflareError(404, []);
      return { id: body.result.id };
    },
    async status(id) {
      const body = await call<{ status: string; ssl?: { status?: string } }>(idPath(id));
      return body ? cloudflareStatus(body.result) : "missing";
    },
    async remove(id) {
      // A hostname that is already gone answers 404, which is what the delete wanted.
      await call(idPath(id), { method: "DELETE" });
    },
    async list() {
      const all: { id: string; hostname: string }[] = [];
      for (let page = 1; page <= 1000; page += 1) {
        const body = await call<{ id: string; hostname: string }[]>(`?per_page=50&page=${page}`);
        const results = body?.result ?? [];
        all.push(...results.map(({ id, hostname }) => ({ id, hostname })));
        if (results.length < 50) break;
      }
      return all;
    },
  };
}

/** A custom hostname's state, reduced: active only when the hostname and its certificate are. */
export function cloudflareStatus(result: {
  status: string;
  ssl?: { status?: string } | undefined;
}): CloudflareStatus {
  const { status, ssl } = result;
  if (status === "active") return ssl?.status === "active" ? "active" : "pending";
  if (status === "moved" || status === "deleted" || status === "blocked") return status;
  return "pending";
}

/**
 * TXT records through Cloudflare's DNS over HTTPS JSON API, never cached by Portifact. A name that
 * does not exist answers no values; a resolver failure throws, so a check that could not look is
 * not counted as a miss.
 */
export function dohTxt(fetcher: Fetch): TxtLookup {
  return async (name) => {
    const url = `${DOH}?name=${encodeURIComponent(name)}&type=TXT`;
    const response = await fetcher(url, {
      headers: { accept: "application/dns-json" },
      redirect: "manual",
    });
    if (!response.ok) throw new CodedError("DOH_HTTP", response.status);
    const body = (await response.json()) as {
      Status: number;
      Answer?: { type: number; data: string }[];
    };
    // NOERROR and NXDOMAIN are answers; anything else (SERVFAIL, REFUSED) is a failed lookup.
    if (body.Status === 3) return [];
    if (body.Status !== 0) throw new CodedError("DOH_RCODE", body.Status);
    // TXT data comes quoted, possibly as several quoted strings that make one value.
    return (body.Answer ?? [])
      .filter((answer) => answer.type === 16)
      .map((answer) =>
        [...answer.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]).join(""),
      );
  };
}

/**
 * Zone apexes through DNS over HTTPS: a name is the apex of a zone exactly when an SOA query for
 * it answers an SOA record of that same name (a name inside a zone gets its zone's SOA in the
 * authority section instead, and a CNAME's target zone has another name). This is how names like
 * `example.co.uk` are refused without the Public Suffix List: whatever the suffix, a registrable
 * domain is the apex of its zone.
 */
export function dohZoneApex(fetcher: Fetch): ZoneApexLookup {
  return async (hostname) => {
    const url = `${DOH}?name=${encodeURIComponent(hostname)}&type=SOA`;
    const response = await fetcher(url, {
      headers: { accept: "application/dns-json" },
      redirect: "manual",
    });
    if (!response.ok) throw new CodedError("DOH_HTTP", response.status);
    const body = (await response.json()) as {
      Status: number;
      Answer?: { name: string; type: number }[];
    };
    if (body.Status === 3) return false;
    if (body.Status !== 0) throw new CodedError("DOH_RCODE", body.Status);
    const name = hostname.toLowerCase();
    return (body.Answer ?? []).some(
      (answer) => answer.type === 6 && answer.name.toLowerCase().replace(/\.$/, "") === name,
    );
  };
}

/** One DNS over HTTPS question: its answers, none for a name that does not exist. */
async function dohAnswers(
  fetcher: Fetch,
  name: string,
  type: "A" | "AAAA",
): Promise<{ type: number; data: string }[]> {
  const url = `${DOH}?name=${encodeURIComponent(name)}&type=${type}`;
  const response = await fetcher(url, {
    headers: { accept: "application/dns-json" },
    redirect: "manual",
  });
  if (!response.ok) throw new CodedError("DOH_HTTP", response.status);
  const body = (await response.json()) as {
    Status: number;
    Answer?: { type: number; data: string }[];
  };
  if (body.Status === 3) return [];
  if (body.Status !== 0) throw new CodedError("DOH_RCODE", body.Status);
  return body.Answer ?? [];
}

const CNAME_TYPE = 5;
const bare = (name: string) => name.toLowerCase().replace(/\.$/, "");

/**
 * Where a name points, through DNS over HTTPS (decision 0006, "Where the name points"): an
 * address query follows the CNAME chain, so a chain that names the target is Portifact's. A
 * customer whose DNS provider flattens or proxies the CNAME shows addresses instead; those count
 * when every one is among the target's own (both families asked). Anything else, including a
 * name that no longer resolves, points elsewhere.
 */
export function dohPointing(fetcher: Fetch, target: string): PointingLookup {
  const wanted = bare(target);
  return async (hostname) => {
    const answers = [
      ...(await dohAnswers(fetcher, hostname, "A")),
      ...(await dohAnswers(fetcher, hostname, "AAAA")),
    ];
    if (answers.some((a) => a.type === CNAME_TYPE && bare(a.data) === wanted)) return true;
    const addresses = answers.filter((a) => a.type !== CNAME_TYPE).map((a) => a.data);
    if (addresses.length === 0) return false;
    const targets = new Set(
      [...(await dohAnswers(fetcher, wanted, "A")), ...(await dohAnswers(fetcher, wanted, "AAAA"))]
        .filter((a) => a.type !== CNAME_TYPE)
        .map((a) => a.data),
    );
    return addresses.every((address) => targets.has(address));
  };
}

/** The variables and secret a Worker reads to switch custom domains on. */
export interface DomainEnv {
  /** Exactly `"true"` switches custom domains on; anything else leaves them unavailable. */
  CUSTOM_DOMAINS_ENABLED?: string | undefined;
  /** The `portifact.dev` zone's ID. */
  CF_CONTENT_ZONE_ID?: string | undefined;
  /** API token with SSL and Certificates Edit on that zone only (secret). */
  CF_HOSTNAMES_TOKEN?: string | undefined;
  /** The deployment's content domain, whose CNAME target names must point at. */
  CONTENT_DOMAIN?: string | undefined;
}

/**
 * Whether this Worker serves artifacts on their custom hosts: exactly `CUSTOM_DOMAINS_ENABLED`
 * set to `"true"`. The app and content Workers decide with this same function, so where the app
 * sends codes and frames, the content Worker answers. Adding and checking domains also need the
 * zone ID and the token (`domainDepsFromEnv`); a Worker switched on without them still serves the
 * domains that exist and logs `custom_domains_misconfigured`.
 */
export function customDomainsServing(env: Pick<DomainEnv, "CUSTOM_DOMAINS_ENABLED">): boolean {
  return env.CUSTOM_DOMAINS_ENABLED === "true";
}

/**
 * The real clients, or null while custom domains are switched off: without the explicit variable,
 * the zone ID or the token, nothing calls Cloudflare and adding or verifying a domain answers
 * `capacity_unavailable`.
 */
export function domainDepsFromEnv(env: DomainEnv, fetcher: Fetch): DomainDeps | null {
  if (!customDomainsServing(env)) return null;
  const zone = env.CF_CONTENT_ZONE_ID ?? "";
  const token = env.CF_HOSTNAMES_TOKEN ?? "";
  const contentDomain = env.CONTENT_DOMAIN ?? "";
  if (!ZONE_ID.test(zone) || token.length < 20 || contentDomain === "") {
    // Switched on without the zone or the token: loudly, since the deployments disagree.
    logEvent("error", "custom_domains_misconfigured");
    return null;
  }
  return {
    hostnames: cloudflareHostnames(fetcher, zone, token),
    txt: dohTxt(fetcher),
    apex: dohZoneApex(fetcher),
    pointing: dohPointing(fetcher, cnameTarget(contentDomain)),
  };
}
