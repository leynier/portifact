// The content Worker's lookup and its redirects with custom domains. Today's single delivery
// read stays the only read per request on a warm isolate, for both kinds of host.

import type { HostDirectory } from "./host-directory.ts";
import { classifyHost, type HostKind } from "./hostname.ts";
import type { Region, Regions } from "./regions.ts";

export interface DeliveryArtifact {
  id: string;
  ownerId: string;
  accessMode: "public" | "authenticated" | "restricted";
  state: string;
  bar: boolean;
  customHost: string | null;
}

export interface Resolved {
  artifact: DeliveryArtifact;
  region: Region;
  /** Which kind of host the request came on. */
  via: "artifact" | "custom";
}

/** Region of an artifact ID: the cached artifact directory of decision 0005. */
export type RegionOf = (artifactId: string) => Promise<Region | null>;

interface Row {
  id: string;
  owner_id: string;
  access_mode: DeliveryArtifact["accessMode"];
  state: string;
  bar: number;
  custom_host: string | null;
}

const COLUMNS = "id, owner_id, access_mode, state, bar, custom_host";

function toArtifact(row: Row): DeliveryArtifact {
  return {
    id: row.id,
    ownerId: row.owner_id,
    accessMode: row.access_mode,
    state: row.state,
    bar: row.bar === 1,
    customHost: row.custom_host,
  };
}

/**
 * From the request's host to the artifact. On `<id>.portifact.dev` it is today's lookup by ID
 * (the row also says whether a custom host is active, for the canonical redirect). On a custom
 * host the hint gives the artifact and region and the regional row must still carry this exact
 * host; when it does not, the hint was stale, so it is read again once from the global table.
 */
export async function resolveDelivery(
  regions: Regions,
  hosts: HostDirectory,
  regionOf: RegionOf,
  hostname: string,
  contentDomain: string,
): Promise<Resolved | null> {
  const host: HostKind = classifyHost(hostname, contentDomain);
  if (host.kind === "none") return null;
  if (host.kind === "artifact") {
    const region = await regionOf(host.artifactId);
    if (!region) return null;
    const row = await regions
      .db(region)
      .prepare(`select ${COLUMNS} from artifacts where id = ?`)
      .bind(host.artifactId)
      .first<Row>();
    return row ? { artifact: toArtifact(row), region, via: "artifact" } : null;
  }
  let hint = await hosts.hint(host.hostname);
  for (let attempt = 0; hint && attempt < 2; attempt += 1) {
    const row = await regions
      .db(hint.region)
      .prepare(`select ${COLUMNS} from artifacts where id = ? and custom_host = ?`)
      .bind(hint.artifactId, host.hostname)
      .first<Row>();
    if (row) return { artifact: toArtifact(row), region: hint.region, via: "custom" };
    hint = attempt === 0 ? await hosts.refresh(host.hostname) : null;
  }
  return null;
}

/** A `GET` navigation of the browser's own tab, as `isTopLevelVisit` in apps/content. */
export function isTopLevelVisit(request: Request): boolean {
  const headers = request.headers;
  return (
    request.method === "GET" &&
    headers.get("Sec-Fetch-Mode") === "navigate" &&
    headers.get("Sec-Fetch-Dest") === "document"
  );
}

function isReserved(pathname: string): boolean {
  return /^\/__portifact(\/|$)/i.test(pathname);
}

export type TopLevelAnswer =
  | { kind: "serve" }
  | { kind: "viewer" }
  | { kind: "canonical"; location: string };

/**
 * What a request gets once it was authorized (and passed the traffic and budget checks): the
 * same point where the viewer redirect is decided today, so an anonymous visitor of a protected
 * artifact never learns whether it has a bar or a custom domain. The viewer wins when the bar is
 * on, and it frames the canonical origin itself. With the bar off, a top-level visit of a page on
 * `<id>.portifact.dev` while a custom host is active goes to the same path there (308), so links
 * already shared keep working. Frames, subresources, reserved paths and the custom host itself
 * are served as they are.
 */
export function topLevelAnswer(
  request: Request,
  resolved: Resolved,
  opts: { isPage: boolean; skipsViewer: boolean },
): TopLevelAnswer {
  const url = new URL(request.url);
  if (!isTopLevelVisit(request) || isReserved(url.pathname) || !opts.isPage) {
    return { kind: "serve" };
  }
  if (resolved.artifact.bar && !opts.skipsViewer) return { kind: "viewer" };
  const custom = resolved.artifact.customHost;
  if (resolved.via === "artifact" && custom) {
    return { kind: "canonical", location: `https://${custom}${url.pathname}${url.search}` };
  }
  return { kind: "serve" };
}

/**
 * Plain `http:` on a custom host goes to `https:` before anything else. Portifact sends no HSTS
 * there: the domain is the customer's, a max-age would outlive the attachment and
 * `includeSubDomains` would bind the customer's other sites.
 */
export function httpsRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== "http:") return null;
  url.protocol = "https:";
  return new Response(null, {
    status: 308,
    headers: { Location: url.toString(), "Cache-Control": "no-store" },
  });
}
