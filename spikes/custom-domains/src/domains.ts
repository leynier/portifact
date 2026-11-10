// The lifecycle of a custom domain across the global table and the artifact's region. Every step
// that would span two databases goes in the order decision 0005 uses: serving starts only when
// the regional row says so (last on attach) and stops as soon as it does not (first on detach).
import { type HostnameError, normalizeHostname } from "./hostname.ts";
import type { Region, Regions } from "./regions.ts";

/** Claims and their TXT tokens last a week; Cloudflare bills a pending hostname too. */
export const CLAIM_TTL_MS = 7 * 86_400_000;
/** Re-checks the TXT proof may miss in a row before the domain is detached. */
export const MAX_MISSED_CHECKS = 3;
export const TXT_PREFIX = "portifact-verify=";

/** Cloudflare's custom hostnames API on the content zone, reduced to what Portifact needs. */
export interface CustomHostnames {
  create(hostname: string): Promise<{ id: string }>;
  status(id: string): Promise<"pending" | "active" | "moved" | "deleted" | "blocked" | "missing">;
  remove(id: string): Promise<void>;
  list(): Promise<{ id: string; hostname: string }[]>;
}

/** TXT values at a name, from a resolver Portifact does not run (DNS over HTTPS). */
export type TxtLookup = (name: string) => Promise<string[]>;

export interface Deps {
  cloudflare: CustomHostnames;
  txt: TxtLookup;
}

export type DomainError =
  | HostnameError
  | "not_found"
  | "quota_exceeded"
  | "conflict"
  | "unverified"
  | "busy";

type Result<T> = ({ ok: true } & T) | { ok: false; error: DomainError };

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(20))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function txtName(hostname: string): string {
  return `_portifact.${hostname}`;
}

interface DomainRow {
  hostname: string;
  owner_id: string;
  artifact_id: string;
  region: Region;
  state: "provisioning" | "active" | "detaching";
  token_hash: string;
  cf_hostname_id: string | null;
  missed_checks: number;
}

async function domainRow(regions: Regions, hostname: string): Promise<DomainRow | null> {
  return regions.global
    .prepare("select * from custom_domains where hostname = ?")
    .bind(hostname)
    .first<DomainRow>();
}

/**
 * Starts attaching `input` to one artifact of the owner. Nothing is proven yet, so this only
 * stores a claim with a fresh token; a second claim by the same owner replaces the token, and
 * claims of other owners for the same name are untouched. `limit` is the owner's plan
 * entitlement (`customDomains`), resolved in the services.
 */
export async function claimDomain(
  regions: Regions,
  input: {
    ownerId: string;
    artifactId: string;
    region: Region;
    hostname: string;
    limit: number;
    now: number;
  },
): Promise<Result<{ hostname: string; txtName: string; txtValue: string }>> {
  const normalized = normalizeHostname(input.hostname);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const hostname = normalized.hostname;
  const artifact = await regions
    .db(input.region)
    .prepare("select custom_host from artifacts where id = ? and owner_id = ? and state = 'active'")
    .bind(input.artifactId, input.ownerId)
    .first<{ custom_host: string | null }>();
  if (!artifact) return { ok: false, error: "not_found" };
  const used = await regions.global
    .prepare(
      "select count(*) as n, sum(hostname = ?) as same, sum(artifact_id = ?) as mine from custom_domains where owner_id = ? and state != 'detaching'",
    )
    .bind(hostname, input.artifactId, input.ownerId)
    .first<{ n: number; same: number | null; mine: number | null }>();
  if ((used?.same ?? 0) > 0 || (used?.mine ?? 0) > 0 || artifact.custom_host !== null) {
    return { ok: false, error: "conflict" };
  }
  if ((used?.n ?? 0) >= input.limit) return { ok: false, error: "quota_exceeded" };
  const token = newToken();
  await regions.global
    .prepare(
      `insert into domain_claims (hostname, owner_id, artifact_id, region, token_hash, expires_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict (hostname, owner_id) do update set artifact_id = excluded.artifact_id,
         region = excluded.region, token_hash = excluded.token_hash, expires_at = excluded.expires_at`,
    )
    .bind(
      hostname,
      input.ownerId,
      input.artifactId,
      input.region,
      await sha256(token),
      input.now + CLAIM_TTL_MS,
    )
    .run();
  return { ok: true, hostname, txtName: txtName(hostname), txtValue: `${TXT_PREFIX}${token}` };
}

/** Whether the DNS holds this token now: whoever controls the zone published it for this claim. */
async function holdsToken(deps: Deps, hostname: string, tokenHash: string): Promise<boolean> {
  const values = await deps.txt(txtName(hostname));
  for (const value of values) {
    if (
      value.startsWith(TXT_PREFIX) &&
      (await sha256(value.slice(TXT_PREFIX.length))) === tokenHash
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Checks the claim's TXT record and, when it holds, binds the hostname to the claim's artifact.
 * DNS control is the proof, so a valid proof also takes the hostname from another owner who
 * still has it (a domain that changed hands): that artifact stops serving on it first. The
 * Cloudflare hostname is Portifact's and is kept across a transfer. A new hostname is created in
 * Cloudflare only after the proof, so nobody can make Portifact serve a name whose DNS they do
 * not control, even when a stale CNAME still points at Portifact.
 */
export async function verifyClaim(
  regions: Regions,
  deps: Deps,
  input: { ownerId: string; hostname: string; now: number },
): Promise<Result<{ state: "provisioning" }>> {
  const claim = await regions.global
    .prepare("select * from domain_claims where hostname = ? and owner_id = ? and expires_at > ?")
    .bind(input.hostname, input.ownerId, input.now)
    .first<{ artifact_id: string; region: Region; token_hash: string }>();
  if (!claim) return { ok: false, error: "not_found" };
  if (!(await holdsToken(deps, input.hostname, claim.token_hash))) {
    return { ok: false, error: "unverified" };
  }
  const existing = await domainRow(regions, input.hostname);
  if (existing?.state === "detaching") return { ok: false, error: "busy" };
  if (existing) {
    // Regional first: the previous artifact stops serving on this host at its next request.
    await regions
      .db(existing.region)
      .prepare("update artifacts set custom_host = null where id = ? and custom_host = ?")
      .bind(existing.artifact_id, input.hostname)
      .run();
  }
  await regions.global.batch([
    regions.global
      .prepare(
        `insert into custom_domains
           (hostname, owner_id, artifact_id, region, state, token_hash, verified_at, checked_at)
         values (?, ?, ?, ?, 'provisioning', ?, ?, ?)
         on conflict (hostname) do update set owner_id = excluded.owner_id,
           artifact_id = excluded.artifact_id, region = excluded.region, state = 'provisioning',
           token_hash = excluded.token_hash, verified_at = excluded.verified_at,
           checked_at = excluded.checked_at, missed_checks = 0
         where custom_domains.state != 'detaching'`,
      )
      .bind(
        input.hostname,
        input.ownerId,
        claim.artifact_id,
        claim.region,
        claim.token_hash,
        input.now,
        input.now,
      ),
    // Every claim for the name is spent: the next owner must publish a token of their own.
    regions.global.prepare("delete from domain_claims where hostname = ?").bind(input.hostname),
  ]);
  await ensureCloudflareHostname(regions, deps, input.hostname);
  return { ok: true, state: "provisioning" };
}

/** Creates the Cloudflare hostname once; a failed call is retried by the job. */
export async function ensureCloudflareHostname(
  regions: Regions,
  deps: Deps,
  hostname: string,
): Promise<void> {
  const row = await domainRow(regions, hostname);
  if (!row || row.cf_hostname_id !== null || row.state === "detaching") return;
  const created = await deps.cloudflare.create(hostname);
  await regions.global
    .prepare(
      "update custom_domains set cf_hostname_id = ? where hostname = ? and cf_hostname_id is null",
    )
    .bind(created.id, hostname)
    .run();
}

/**
 * Run by the job while a domain is provisioning: once Cloudflare reports the hostname and its
 * certificate active, the artifact row takes the host (guarded: still the owner's, active and
 * without another host), and only then the global row turns active, which is what the content
 * Worker's hint reads. If the artifact cannot take it, the domain is detached.
 */
export async function activateDomain(
  regions: Regions,
  deps: Deps,
  hostname: string,
): Promise<"active" | "pending" | "detached" | "skipped"> {
  const row = await domainRow(regions, hostname);
  if (!row || row.state !== "provisioning" || row.cf_hostname_id === null) return "skipped";
  const status = await deps.cloudflare.status(row.cf_hostname_id);
  if (status !== "active") return "pending";
  const bound = await regions
    .db(row.region)
    .prepare(
      `update artifacts set custom_host = ?
       where id = ? and owner_id = ? and state = 'active' and (custom_host is null or custom_host = ?)`,
    )
    .bind(hostname, row.artifact_id, row.owner_id, hostname)
    .run();
  if (bound.meta.changes !== 1) {
    await detachDomain(regions, hostname);
    return "detached";
  }
  await regions.global
    .prepare(
      "update custom_domains set state = 'active' where hostname = ? and state = 'provisioning' and artifact_id = ?",
    )
    .bind(hostname, row.artifact_id)
    .run();
  return "active";
}

/**
 * Stops serving on a hostname and schedules the Cloudflare hostname's deletion. Regional first,
 * so the host stops at the next request; then, in one global batch, the outbox job conditioned
 * on the old state and the state change last, so a retry writes the job once.
 */
export async function detachDomain(regions: Regions, hostname: string): Promise<boolean> {
  const row = await domainRow(regions, hostname);
  if (!row) return false;
  await regions
    .db(row.region)
    .prepare("update artifacts set custom_host = null where id = ? and custom_host = ?")
    .bind(row.artifact_id, hostname)
    .run();
  await regions.global.batch([
    regions.global
      .prepare(
        `insert into outbox (topic, payload)
         select 'delete_custom_hostname', json_object('hostname', hostname)
         from custom_domains where hostname = ? and state != 'detaching'`,
      )
      .bind(hostname),
    regions.global
      .prepare("update custom_domains set state = 'detaching' where hostname = ?")
      .bind(hostname),
  ]);
  return true;
}

/**
 * The outbox job: deletes the Cloudflare hostname (which also ends its billing), then the row.
 * Idempotent: a missing row means done, and Cloudflare's delete of a missing hostname is a no-op
 * in the client.
 */
export async function runDeleteHostname(
  regions: Regions,
  deps: Deps,
  hostname: string,
): Promise<"done"> {
  const row = await domainRow(regions, hostname);
  if (!row || row.state !== "detaching") return "done";
  if (row.cf_hostname_id !== null) await deps.cloudflare.remove(row.cf_hostname_id);
  await regions.global
    .prepare("delete from custom_domains where hostname = ? and state = 'detaching'")
    .bind(hostname)
    .run();
  return "done";
}

/** Detaches every domain of one artifact: suspension, purge and account or workspace deletion. */
export async function detachArtifactDomains(regions: Regions, artifactId: string): Promise<number> {
  const rows = await regions.global
    .prepare("select hostname from custom_domains where artifact_id = ? and state != 'detaching'")
    .bind(artifactId)
    .all<{ hostname: string }>();
  for (const { hostname } of rows.results) await detachDomain(regions, hostname);
  return rows.results.length;
}

/**
 * Suspension (operator tool only): the artifact row becomes suspended and loses its host in one
 * regional batch, then the domain is detached, so the hostname is withdrawn from Cloudflare.
 * Reinstating does not bring it back: the owner attaches it again with a fresh proof.
 */
export async function suspendArtifact(
  regions: Regions,
  input: { artifactId: string; region: Region },
): Promise<void> {
  await regions
    .db(input.region)
    .prepare("update artifacts set state = 'suspended', custom_host = null where id = ?")
    .bind(input.artifactId)
    .run();
  await detachArtifactDomains(regions, input.artifactId);
}

/**
 * The periodic re-check: the TXT proof must stay published. After `MAX_MISSED_CHECKS` misses in
 * a row the domain is detached, so a domain that expired, was sold or was repointed stops
 * serving the old owner's artifact, and its new holder can claim it with a token of their own.
 */
export async function recheckDomain(
  regions: Regions,
  deps: Deps,
  hostname: string,
  now: number,
): Promise<"kept" | "missed" | "detached" | "skipped"> {
  const row = await domainRow(regions, hostname);
  if (!row || row.state === "detaching") return "skipped";
  if (await holdsToken(deps, hostname, row.token_hash)) {
    await regions.global
      .prepare("update custom_domains set checked_at = ?, missed_checks = 0 where hostname = ?")
      .bind(now, hostname)
      .run();
    return "kept";
  }
  if (row.missed_checks + 1 >= MAX_MISSED_CHECKS) {
    await detachDomain(regions, hostname);
    return "detached";
  }
  await regions.global
    .prepare(
      "update custom_domains set checked_at = ?, missed_checks = missed_checks + 1 where hostname = ?",
    )
    .bind(now, hostname)
    .run();
  return "missed";
}

/**
 * A plan with fewer domains than the owner has (downgrade, lapse): the oldest stay, the newest
 * are detached. Nothing else changes: the artifacts keep their Portifact origin.
 */
export async function enforceDomainLimit(
  regions: Regions,
  ownerId: string,
  limit: number,
): Promise<string[]> {
  const rows = await regions.global
    .prepare(
      "select hostname from custom_domains where owner_id = ? and state != 'detaching' order by verified_at, hostname",
    )
    .bind(ownerId)
    .all<{ hostname: string }>();
  const extra = rows.results.slice(Math.max(0, limit)).map((r) => r.hostname);
  for (const hostname of extra) await detachDomain(regions, hostname);
  return extra;
}

/** Removes claims past their week; they never reached Cloudflare, so nothing else to clean. */
export async function pruneClaims(regions: Regions, now: number): Promise<number> {
  const result = await regions.global
    .prepare("delete from domain_claims where expires_at <= ?")
    .bind(now)
    .run();
  return result.meta.changes;
}

/**
 * After a D1 Time Travel restore, Cloudflare is the record of which hostnames exist: a row whose
 * Cloudflare hostname is gone or names another host is detached (it may have been released and
 * claimed by someone else after the restore point), and a Cloudflare hostname with no row is
 * deleted (it was attached after the restore point). Provisioning rows without a Cloudflare ID
 * are left to `ensureCloudflareHostname`.
 */
export async function reconcileWithCloudflare(
  regions: Regions,
  deps: Deps,
): Promise<{ detached: string[]; removed: string[] }> {
  const live = new Map((await deps.cloudflare.list()).map((h) => [h.id, h.hostname]));
  const rows = await regions.global
    .prepare("select hostname, cf_hostname_id, state from custom_domains")
    .all<{ hostname: string; cf_hostname_id: string | null; state: string }>();
  const detached: string[] = [];
  const known = new Set<string>();
  for (const row of rows.results) {
    if (row.cf_hostname_id === null) continue;
    known.add(row.cf_hostname_id);
    if (live.get(row.cf_hostname_id) !== row.hostname && row.state !== "detaching") {
      await detachDomain(regions, row.hostname);
      detached.push(row.hostname);
    }
  }
  const removed: string[] = [];
  for (const [id, hostname] of live) {
    if (!known.has(id)) {
      await deps.cloudflare.remove(id);
      removed.push(hostname);
    }
  }
  return { detached, removed };
}
