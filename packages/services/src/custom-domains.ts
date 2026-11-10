// Custom domains (premium plan P7, decision 0006): an admin or editor of an owner whose plan
// includes `customDomains` serves one artifact from a hostname they control.
//
// - A claim (`domain_claims`, global) holds a fresh token per owner and name. Nothing reaches
//   Cloudflare until the TXT record `_portifact.<host>` holds that token, so a stale CNAME that
//   still points at Portifact never lets anyone else take a released name.
// - The proof moves the name to `custom_domains` (global) as `provisioning`, spends every claim of
//   the name and creates the Cloudflare hostname. When Cloudflare reports the hostname and its
//   certificate active, `artifacts.custom_host` (regional) takes the name, and only then the row
//   turns `active`. That column is the authority for serving: attaching sets it last, detaching
//   clears it first, so a removal holds at the next request whatever any cache says.
// - Detaching writes a `delete_custom_hostname` outbox job once, conditioned on the old state;
//   the job deletes the Cloudflare hostname and then the row, which frees the name.
// - The scheduled check activates what Cloudflare finished, re-checks the TXT proof and
//   Cloudflare's status daily (three misses in a row detach), detaches what waited too long and
//   what a lower plan no longer allows (the oldest stay), and prunes expired claims.
//
// Every call to Cloudflare or DNS goes through `DomainDeps`; with none (the feature switched off)
// adding and verifying answer `capacity_unavailable` and nothing calls out.
import {
  CUSTOM_DOMAINS,
  type CustomDomainProblem,
  type CustomDomainState,
  txtRecordName,
  txtRecordValue,
} from "@portifact/contracts";
import {
  type Db,
  type GlobalDb,
  type Region,
  type RegionalDb,
  type Regions,
  schema,
} from "@portifact/db";
import {
  type Actor,
  authorize,
  can,
  checkDomainCount,
  checkPointing,
  checkProvenDomain,
  claimExpiry,
  type DetachReason,
  domainLimit,
  domainLimitAt,
  domainsOverLimit,
  type Entitlements,
  entitlements,
  fail,
  holdsTxt,
  hostnameRefusal,
  isBlockedHostname,
  normalizeBlockName,
  normalizeHostname,
  ok,
  type Pointing,
  provisioningExpired,
  type Result,
  recheckDue,
} from "@portifact/domain";
import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { actorOn, artifactHandles, authorizeOn } from "./actors.ts";
import { type AuditActor, auditEvent } from "./audit.ts";
import type { DomainDeps } from "./cloudflare-hostnames.ts";
import { scheduleDomainNotices } from "./domain-notices.ts";
import type { JobOutcome } from "./outbox.ts";
import { requireOwnerFeature } from "./plans.ts";

const c = schema.customDomains;
const k = schema.domainClaims;
const a = schema.artifacts;

type DomainRow = typeof schema.customDomains.$inferSelect;
type ClaimRow = typeof schema.domainClaims.$inferSelect;

/** Rows each scheduled pass looks at, per kind of work, so a run stays short. */
export const DOMAIN_CHECK_BATCH = 25;
const PRUNE_BATCH = 500;
const IN_CHUNK = 80;

const missingArtifact = () => fail<never>("not_found", "Artifact not found.");
const missingDomain = () => fail<never>("not_found", "Custom domain not found.");
const unavailable = () =>
  fail<never>("capacity_unavailable", "Custom domains are not available yet.");
const busy = (hostname: string) =>
  fail<never>("version_conflict", `${hostname} is being removed. Try again in a few minutes.`);

/**
 * The databases custom domains touch: the global one (claims and domains) and each region's
 * (the artifact's `custom_host`).
 */
export interface DomainDbs {
  global: Db;
  regional(region: Region): Db;
}

export function domainDbs(regions: Regions): DomainDbs {
  return { global: regions.global, regional: (region) => regions.get(region).db };
}

/**
 * For the paths that hold the artifact's own region (purges, suspensions): the artifact's
 * `custom_host` is in `db`, the domains in its deployment's global database.
 */
export function domainDbsOf(db: Db | RegionalDb): DomainDbs {
  const global = "global" in db ? db.global : db;
  return { global, regional: () => db };
}

/** One domain or pending claim, as the services hand it to the adapters. */
export interface DomainRecord {
  hostname: string;
  artifactId: string;
  ownerId: string;
  state: CustomDomainState;
  /** The TXT record's token: public once published, and needed to show the record again. */
  token: string;
  claimExpiresAt: number | null;
  verifiedAt: number | null;
  checkedAt: number | null;
  missedChecks: number;
  problem: CustomDomainProblem | null;
}

function domainRecord(row: DomainRow): DomainRecord {
  return {
    hostname: row.hostname,
    artifactId: row.artifactId,
    ownerId: row.ownerId,
    state: row.state === "detaching" ? "removing" : row.state,
    token: row.token,
    claimExpiresAt: null,
    verifiedAt: row.verifiedAt,
    checkedAt: row.checkedAt,
    missedChecks: row.missedChecks,
    problem: row.problem,
  };
}

function claimRecord(row: ClaimRow, problem: CustomDomainProblem | null = null): DomainRecord {
  return {
    hostname: row.hostname,
    artifactId: row.artifactId,
    ownerId: row.ownerId,
    state: "pending",
    token: row.token,
    claimExpiresAt: row.expiresAt,
    verifiedAt: null,
    checkedAt: null,
    missedChecks: 0,
    problem,
  };
}

/** A token of 32 hex characters (128 bits) from the platform's CSPRNG. */
function newToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function domainRow(global: Db, hostname: string): Promise<DomainRow | undefined> {
  const [row] = await global.select().from(c).where(eq(c.hostname, hostname)).limit(1);
  return row;
}

async function loadArtifact(db: Db, artifactId: string) {
  const [artifact] = await db
    .select({ id: a.id, ownerId: a.ownerId, state: a.state, customHost: a.customHost })
    .from(a)
    .where(eq(a.id, artifactId))
    .limit(1);
  if (!artifact || artifact.state === "deleted" || artifact.state === "purging") return null;
  return artifact;
}

export interface AddDomainInput {
  userId: string;
  artifactId: string;
  hostname: string;
  /** The deployment's content domain, reserved like Portifact's own domains. */
  contentDomain: string;
  now: number;
}

/**
 * Starts attaching a hostname to an artifact: stores a claim with a fresh token for the owner
 * and returns it with the records to create. Adding the same name to the same artifact again
 * keeps the token while the claim lasts, so a retry never invalidates a record already published.
 * Claims of other owners for the name are untouched: whoever proves control of the DNS wins.
 */
export async function addCustomDomain(
  regions: Regions,
  deps: DomainDeps | null,
  input: AddDomainInput,
): Promise<Result<DomainRecord>> {
  const handles = await artifactHandles(regions, input.artifactId);
  if (!handles) return missingArtifact();
  const artifact = await loadArtifact(handles.db, input.artifactId);
  if (!artifact) return missingArtifact();
  const actor = await authorizeOn(
    handles.db,
    input.userId,
    artifact.ownerId,
    "access",
    missingArtifact,
  );
  if (!actor.ok) return actor;
  const gate = await requireOwnerFeature(regions.global, artifact, "customDomains", input.now);
  if (!gate.ok) return gate;
  if (!deps) return unavailable();
  if (artifact.state !== "active") {
    return fail("invalid_input", "Only an active artifact can get a custom domain.");
  }
  const normalized = normalizeHostname(input.hostname, input.contentDomain);
  if (!normalized.ok) return normalized;
  const hostname = normalized.value;
  const refused = await refusedName(regions.global, deps, hostname);
  if (refused) return refused;

  const owned = await regions.global
    .select()
    .from(c)
    .where(and(eq(c.ownerId, artifact.ownerId), ne(c.state, "detaching")));
  const same = owned.find((row) => row.hostname === hostname);
  if (same) {
    if (same.artifactId === artifact.id) return ok(domainRecord(same));
    return fail(
      "invalid_input",
      `${hostname} is already the custom domain of another artifact. Remove it there first.`,
    );
  }
  const current =
    owned.find((row) => row.artifactId === artifact.id)?.hostname ?? artifact.customHost;
  if (current !== null) {
    return fail(
      "invalid_input",
      `This artifact already has the custom domain ${current}. Remove it first.`,
    );
  }
  const count = checkDomainCount(owned.length, domainLimit(gate.value));
  if (!count.ok) return count;

  const expiresAt = claimExpiry(input.now);
  const [claim] = await regions.global
    .insert(k)
    .values({
      hostname,
      ownerId: artifact.ownerId,
      artifactId: artifact.id,
      region: handles.region,
      token: newToken(),
      expiresAt,
      createdAt: input.now,
    })
    .onConflictDoUpdate({
      target: [k.hostname, k.ownerId],
      set: {
        artifactId: artifact.id,
        region: handles.region,
        // A live claim keeps its token; SET reads the old row, so this compares its old expiry.
        token: sql`case when ${k.expiresAt} > ${input.now} then ${k.token} else excluded.token end`,
        expiresAt,
      },
    })
    .returning();
  return ok(claimRecord(claim as ClaimRow));
}

/** What a user can reach under one hostname: a claim of an owner they act for, and the domain. */
interface Reach {
  claim: ClaimRow | null;
  domain: DomainRow | null;
}

/**
 * The live claim and the domain of `hostname` that `userId` may manage (an admin or editor of
 * their owner). Someone else's claim or domain is invisible: `not_found`, like a missing one.
 * A role that does not allow managing them answers `forbidden`.
 */
async function reach(
  global: GlobalDb,
  userId: string,
  input: string,
  now: number,
): Promise<Result<Reach>> {
  const normalized = normalizeHostname(input);
  if (!normalized.ok) return missingDomain();
  const hostname = normalized.value;
  let forbidden = false;
  const allowed = async (ownerId: string) => {
    const actor = await actorOn(global, userId, ownerId);
    if (!actor) return false;
    if (can(actor, "access")) return true;
    forbidden = true;
    return false;
  };
  let claim: ClaimRow | null = null;
  for (const row of await global
    .select()
    .from(k)
    .where(and(eq(k.hostname, hostname), sql`${k.expiresAt} > ${now}`))
    .orderBy(asc(k.createdAt))) {
    if (await allowed(row.ownerId)) {
      claim = row;
      break;
    }
  }
  const found = await domainRow(global, hostname);
  const domain = found && (await allowed(found.ownerId)) ? found : null;
  if (claim || domain) return ok({ claim, domain });
  return forbidden
    ? fail("forbidden", "Your role on this workspace does not allow this.")
    : missingDomain();
}

/** One domain or claim of the caller, by hostname. Never behind the plan. */
export async function getCustomDomain(
  regions: Regions,
  input: { userId: string; hostname: string; now: number },
): Promise<Result<DomainRecord>> {
  const found = await reach(regions.global, input.userId, input.hostname, input.now);
  if (!found.ok) return found;
  const { claim, domain } = found.value;
  return ok(domain ? domainRecord(domain) : claimRecord(claim as ClaimRow));
}

/**
 * Checks a claim's TXT record and, when it holds, binds the name to the claim's artifact and
 * creates the Cloudflare hostname; on a proven domain, checks again (activation, the TXT record).
 * Gated on the plan of the owner whose claim or domain it is.
 */
export async function verifyCustomDomain(
  regions: Regions,
  deps: DomainDeps | null,
  input: { userId: string; hostname: string; now: number },
): Promise<Result<DomainRecord>> {
  const found = await reach(regions.global, input.userId, input.hostname, input.now);
  if (!found.ok) return found;
  const { claim, domain } = found.value;
  const ownerId = claim?.ownerId ?? (domain as DomainRow).ownerId;
  const gate = await requireOwnerFeature(regions.global, { ownerId }, "customDomains", input.now);
  if (!gate.ok) return gate;
  if (!deps) return unavailable();
  const dbs = domainDbs(regions);
  if (claim) {
    return proveClaim(dbs, deps, claim, gate.value, input.now, { type: "user", id: input.userId });
  }
  return checkAgain(dbs, deps, domain as DomainRow, input.now);
}

/** The TXT record at the claim's name, or null when DNS could not be asked. */
async function lookupTxt(deps: DomainDeps, hostname: string): Promise<string[] | null> {
  try {
    return await deps.txt(txtRecordName(hostname));
  } catch {
    return null;
  }
}

/** Where the name points now, or `unknown` when DNS could not be asked. */
async function lookupPointing(deps: DomainDeps, hostname: string): Promise<Pointing> {
  try {
    return (await deps.pointing(hostname)) ? "here" : "elsewhere";
  } catch {
    return "unknown";
  }
}

const dnsUnavailable = () =>
  fail<never>("capacity_unavailable", "DNS could not be checked right now. Try again in a minute.");

/** The operator's block list: a small table read whole. */
export async function blockedNames(global: Db): Promise<string[]> {
  return (
    await global.select({ name: schema.blockedHostnames.name }).from(schema.blockedHostnames)
  ).map((row) => row.name);
}

/**
 * Why a normalized hostname cannot be a custom domain beyond its shape: the operator blocked it
 * (or a name above it), or it is the apex of its DNS zone. Null when it may be used.
 */
async function refusedName(
  global: Db,
  deps: DomainDeps,
  hostname: string,
): Promise<Result<never> | null> {
  if (isBlockedHostname(hostname, await blockedNames(global))) return hostnameRefusal("blocked");
  let apex: boolean;
  try {
    apex = await deps.apex(hostname);
  } catch {
    return dnsUnavailable();
  }
  return apex ? hostnameRefusal("zone_apex") : null;
}

async function proveClaim(
  dbs: DomainDbs,
  deps: DomainDeps,
  claim: ClaimRow,
  owner: Entitlements,
  now: number,
  actor?: AuditActor,
): Promise<Result<DomainRecord>> {
  const values = await lookupTxt(deps, claim.hostname);
  if (values === null) return dnsUnavailable();
  if (!holdsTxt(values, txtRecordValue(claim.token))) return ok(claimRecord(claim, "txt_missing"));
  // Checked again before anything reaches Cloudflare: the operator may have blocked the name, and
  // a zone apex can never hold the CNAME (it would wait out the provisioning grace for nothing).
  const refused = await refusedName(dbs.global, deps, claim.hostname);
  if (refused) {
    await dbs.global
      .delete(k)
      .where(and(eq(k.hostname, claim.hostname), eq(k.ownerId, claim.ownerId)));
    return refused;
  }

  const hostname = claim.hostname;
  const artifact = await loadArtifact(dbs.regional(claim.region), claim.artifactId);
  if (!artifact || artifact.ownerId !== claim.ownerId || artifact.state !== "active") {
    await dbs.global.delete(k).where(and(eq(k.hostname, hostname), eq(k.ownerId, claim.ownerId)));
    return fail(
      "invalid_input",
      "The artifact this domain was added to is no longer active. Add the domain again.",
    );
  }
  const [other] = await dbs.global
    .select({ hostname: c.hostname })
    .from(c)
    .where(
      and(eq(c.artifactId, claim.artifactId), ne(c.state, "detaching"), ne(c.hostname, hostname)),
    )
    .limit(1);
  if (other) {
    return fail(
      "invalid_input",
      `This artifact already has the custom domain ${other.hostname}. Remove it first.`,
    );
  }
  const existing = await domainRow(dbs.global, hostname);
  if (existing?.state === "detaching") return busy(hostname);
  const limit = domainLimit(owner);
  // Checked before the previous holder loses the host, so a proof that cannot fit changes
  // nothing; the batch below checks it again against concurrent proofs.
  const fitsNow = checkDomainCount(await countOwned(dbs.global, claim.ownerId, hostname), limit);
  if (!fitsNow.ok) return fitsNow;
  if (existing) {
    // The name changes hands: the previous artifact stops serving on it first.
    await clearHost(dbs.regional(existing.region), existing.artifactId, hostname);
  }

  const fits = sql`(select count(*) from ${c} where ${c.ownerId} = ${claim.ownerId} and ${c.state} != 'detaching' and ${c.hostname} != ${hostname}) < ${limit}`;
  const live = sql`exists (select 1 from ${k} where ${k.hostname} = ${hostname} and ${k.ownerId} = ${claim.ownerId} and ${k.token} = ${claim.token} and ${k.expiresAt} > ${now})`;
  const proven = sql`exists (select 1 from ${c} where ${c.hostname} = ${hostname} and ${c.ownerId} = ${claim.ownerId} and ${c.token} = ${claim.token} and ${c.verifiedAt} = ${now} and ${c.state} = 'provisioning')`;
  await dbs.global.batch([
    // Before the writes, on the claim being live and fitting: the proof's batch deletes the
    // claim, so a second proof of the same claim records nothing.
    auditEvent(
      dbs.global,
      {
        ownerId: claim.ownerId,
        kind: "domain.attached",
        actor: actor ?? { type: "system" },
        targetId: claim.artifactId,
        artifactId: claim.artifactId,
        detail: { hostname },
        now,
      },
      sql`${live} and ${fits} and not exists (select 1 from ${c} where ${c.hostname} = ${hostname} and ${c.state} = 'detaching')`,
    ),
    // A transfer keeps the Cloudflare hostname, which is Portifact's and names the same host.
    dbs.global
      .update(c)
      .set({
        ownerId: claim.ownerId,
        artifactId: claim.artifactId,
        region: claim.region,
        state: "provisioning",
        token: claim.token,
        verifiedAt: now,
        checkedAt: now,
        missedChecks: 0,
        problem: null,
        detachReason: null,
        noticeFor: null,
        missedPointChecks: 0,
      })
      .where(and(eq(c.hostname, hostname), ne(c.state, "detaching"), live, fits)),
    // Columns in schema order: hostname, owner, artifact, region, state, token, Cloudflare ID,
    // verified, checked, missed checks, problem, detach reason, created, notice, missed point checks.
    dbs.global
      .insert(c)
      .select(
        sql`select ${hostname}, ${claim.ownerId}, ${claim.artifactId}, ${claim.region}, 'provisioning', ${claim.token}, null, ${now}, ${now}, 0, null, null, ${now}, null, 0 where not exists (select 1 from ${c} where ${c.hostname} = ${hostname}) and ${live} and ${fits}`,
      ),
    // Every claim of the name is spent: the next owner must publish a token of their own.
    dbs.global.delete(k).where(and(eq(k.hostname, hostname), proven)),
  ]);
  const row = await domainRow(dbs.global, hostname);
  if (
    !row ||
    row.ownerId !== claim.ownerId ||
    row.token !== claim.token ||
    row.verifiedAt !== now
  ) {
    const count = checkDomainCount(await countOwned(dbs.global, claim.ownerId, hostname), limit);
    if (!count.ok) return count;
    return fail("version_conflict", `${hostname} changed meanwhile. Try again.`);
  }
  return ok(domainRecord(await provision(dbs, deps, row, now)));
}

/** The owner's domains that count toward the limit, other than `hostname`. */
async function countOwned(global: Db, ownerId: string, hostname: string): Promise<number> {
  const [counted] = await global
    .select({ n: sql<number>`count(*)` })
    .from(c)
    .where(and(eq(c.ownerId, ownerId), ne(c.state, "detaching"), ne(c.hostname, hostname)));
  return counted?.n ?? 0;
}

/** "Check again" on a proven domain: activation while provisioning, the TXT record once active. */
async function checkAgain(
  dbs: DomainDbs,
  deps: DomainDeps,
  row: DomainRow,
  now: number,
): Promise<Result<DomainRecord>> {
  if (row.state === "detaching") return busy(row.hostname);
  if (row.state === "provisioning") return ok(domainRecord(await provision(dbs, deps, row, now)));
  const values = await lookupTxt(deps, row.hostname);
  const pointing = await lookupPointing(deps, row.hostname);
  if (values === null || pointing === "unknown") return dnsUnavailable();
  const held = holdsTxt(values, txtRecordValue(row.token));
  const here = pointing === "here";
  // Only the daily check counts misses; a record found again clears its own count.
  await dbs.global
    .update(c)
    .set({
      problem: !held ? "txt_missing" : !here ? "cname_elsewhere" : null,
      ...(held ? { missedChecks: 0 } : {}),
      ...(here ? { missedPointChecks: 0 } : {}),
      ...(held && here ? { checkedAt: now } : {}),
    })
    .where(and(eq(c.hostname, row.hostname), eq(c.state, "active"), eq(c.token, row.token)));
  return ok(domainRecord((await domainRow(dbs.global, row.hostname)) ?? row));
}

async function setProblem(global: Db, row: DomainRow, problem: CustomDomainProblem, now: number) {
  await global
    .update(c)
    .set({ problem, checkedAt: now })
    .where(and(eq(c.hostname, row.hostname), eq(c.state, row.state), eq(c.token, row.token)));
}

async function clearHost(regional: Db, artifactId: string, hostname: string) {
  await regional
    .update(a)
    .set({ customHost: null })
    .where(and(eq(a.id, artifactId), eq(a.customHost, hostname)));
}

/**
 * Brings a `provisioning` domain forward: creates its Cloudflare hostname once, then activates it
 * when Cloudflare reports it and its certificate active. Cloudflare failures are recorded as the
 * domain's problem and retried by the scheduled check. Returns the row as it ends.
 */
export async function provision(
  dbs: DomainDbs,
  deps: DomainDeps,
  start: DomainRow,
  now: number,
): Promise<DomainRow> {
  const reread = async () => (await domainRow(dbs.global, start.hostname)) ?? start;
  let row = start;
  if (row.state !== "provisioning") return row;
  if (row.cfHostnameId === null) {
    let created: { id: string };
    try {
      created = await deps.hostnames.create(row.hostname);
    } catch {
      await setProblem(dbs.global, row, "cloudflare_unavailable", now);
      return reread();
    }
    const stored = await dbs.global
      .update(c)
      .set({ cfHostnameId: created.id })
      .where(and(eq(c.hostname, row.hostname), isNull(c.cfHostnameId), eq(c.state, "provisioning")))
      .returning({ hostname: c.hostname });
    if (stored.length === 0) {
      // The row changed meanwhile (detached, or another request stored its own): this hostname
      // would have no row, so it goes again.
      const current = await domainRow(dbs.global, row.hostname);
      if (current?.cfHostnameId !== created.id) await removeQuietly(deps, created.id);
      return reread();
    }
    row = { ...row, cfHostnameId: created.id };
  }
  let status: Awaited<ReturnType<DomainDeps["hostnames"]["status"]>>;
  try {
    status = await deps.hostnames.status(row.cfHostnameId as string);
  } catch {
    await setProblem(dbs.global, row, "cloudflare_unavailable", now);
    return reread();
  }
  if (status === "pending") {
    if (provisioningExpired(row.verifiedAt, now)) {
      await detachDomain(dbs, row.hostname, "provisioning_timeout", now);
    } else {
      await setProblem(dbs.global, row, "certificate_pending", now);
    }
    return reread();
  }
  if (status !== "active") {
    await detachDomain(dbs, row.hostname, "cloudflare_gone", now);
    return reread();
  }
  // Activated only while the name resolves to Portifact's target, so a certificate Cloudflare
  // issued earlier never serves a name already pointed elsewhere; the provisioning grace still
  // applies. DNS that could not be asked waits for the next run.
  const pointing = await lookupPointing(deps, row.hostname);
  if (pointing !== "here") {
    if (provisioningExpired(row.verifiedAt, now)) {
      await detachDomain(dbs, row.hostname, "provisioning_timeout", now);
    } else if (pointing === "elsewhere") {
      await setProblem(dbs.global, row, "cname_elsewhere", now);
    }
    return reread();
  }
  await activate(dbs, row, now);
  return reread();
}

async function removeQuietly(deps: DomainDeps, id: string) {
  try {
    await deps.hostnames.remove(id);
  } catch {
    // The reconciliation deletes Cloudflare hostnames that have no row.
  }
}

/**
 * The artifact takes the host only while it is still the owner's, active and without another
 * host. True when it holds it after this call.
 */
async function bindHost(regional: Db, row: DomainRow): Promise<boolean> {
  try {
    const bound = await regional
      .update(a)
      .set({ customHost: row.hostname })
      .where(
        and(
          eq(a.id, row.artifactId),
          eq(a.ownerId, row.ownerId),
          eq(a.state, "active"),
          or(isNull(a.customHost), eq(a.customHost, row.hostname)),
        ),
      )
      .returning({ id: a.id });
    return bound.length > 0;
  } catch {
    // The unique index: another artifact still holds the name. It is cleared before a transfer,
    // so this is a leftover that the detach and its job clean up.
    return false;
  }
}

/**
 * The row turns active first (only while it is still this owner's claim for this artifact), then
 * the artifact takes the host. Every path that sends a visitor to a custom host needs both (the
 * content Worker's lookup matches the regional column, its `.dev` redirect also the hint from the
 * active row, the app's entries `activeCustomHost`), so in between nothing is served or sent
 * there: the custom host answers 404 and `.dev` serves as before. The opposite order would leave
 * a moment where the regional column names a host whose row is still provisioning, which a new
 * holder of the name could take. If the artifact cannot take the host, the domain is detached; a
 * Worker that stops in between leaves an active row without the regional column, which the daily
 * check binds again (`recheck`).
 */
async function activate(dbs: DomainDbs, row: DomainRow, now: number) {
  const activated = await dbs.global
    .update(c)
    .set({ state: "active", problem: null, checkedAt: now, missedChecks: 0 })
    .where(
      and(
        eq(c.hostname, row.hostname),
        eq(c.state, "provisioning"),
        eq(c.ownerId, row.ownerId),
        eq(c.artifactId, row.artifactId),
        eq(c.token, row.token),
      ),
    )
    .returning({ hostname: c.hostname });
  if (activated.length === 0) return;
  if (!(await bindHost(dbs.regional(row.region), row))) {
    await detachDomain(dbs, row.hostname, "artifact_unavailable", now);
  }
}

/**
 * Stops serving on a hostname and schedules its Cloudflare hostname's deletion. Regional first,
 * so the host stops at the next request; then one global batch writes the outbox job and the
 * state change on the same old state, so a retried or concurrent detach writes the job once.
 * `expect` limits it to a row still bound to that owner or artifact. True when this call
 * detached it.
 */
export async function detachDomain(
  dbs: DomainDbs,
  hostname: string,
  reason: DetachReason,
  now: number,
  expect: { ownerId?: string; artifactId?: string } = {},
  actor: AuditActor = { type: "system" },
): Promise<boolean> {
  const row = await domainRow(dbs.global, hostname);
  if (!row || row.state === "detaching") return false;
  if (expect.ownerId !== undefined && row.ownerId !== expect.ownerId) return false;
  if (expect.artifactId !== undefined && row.artifactId !== expect.artifactId) return false;
  await clearHost(dbs.regional(row.region), row.artifactId, hostname);
  const same: SQL = sql`${c.hostname} = ${hostname} and ${c.state} != 'detaching' and ${c.ownerId} = ${row.ownerId} and ${c.artifactId} = ${row.artifactId}`;
  const [, , detached] = await dbs.global.batch([
    // Before the state change, on the same old state, as the job.
    auditEvent(
      dbs.global,
      {
        ownerId: row.ownerId,
        kind: "domain.removed",
        actor,
        targetId: row.artifactId,
        artifactId: row.artifactId,
        detail: { hostname, reason },
        now,
      },
      sql`exists (select 1 from ${c} where ${same})`,
    ),
    // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
    // subject, generation.
    dbs.global
      .insert(schema.outbox)
      .select(
        sql`select null, 'delete_custom_hostname', '{}', ${now}, null, 0, ${now}, ${hostname}, null from ${c} where ${same}`,
      ),
    dbs.global
      .update(c)
      .set({ state: "detaching", detachReason: reason, problem: null })
      .where(same)
      .returning({ hostname: c.hostname }),
  ]);
  return detached.length > 0;
}

/**
 * The `delete_custom_hostname` job: makes sure the artifact no longer holds the host, deletes
 * the Cloudflare hostname (which ends its billing and certificates) and then the row, which
 * frees the name. Idempotent: a missing row means done, and deleting a hostname Cloudflare no
 * longer has succeeds.
 */
export async function runDeleteHostname(
  dbs: DomainDbs,
  deps: DomainDeps | null,
  hostname: string,
): Promise<JobOutcome> {
  const row = await domainRow(dbs.global, hostname);
  if (!row) return "done";
  if (row.state !== "detaching") return "stale";
  await clearHost(dbs.regional(row.region), row.artifactId, hostname);
  if (row.cfHostnameId !== null) {
    // Thrown, not reported done: the row stays and the job runs again where the client is.
    if (!deps) throw new Error("delete_custom_hostname needs the Cloudflare client");
    await deps.hostnames.remove(row.cfHostnameId);
  }
  await dbs.global
    .delete(c)
    .where(
      and(
        eq(c.hostname, hostname),
        eq(c.state, "detaching"),
        row.cfHostnameId === null ? isNull(c.cfHostnameId) : eq(c.cfHostnameId, row.cfHostnameId),
      ),
    );
  return "done";
}

/**
 * Removes the caller's claim and detaches the caller's domain under `hostname`. Never behind the
 * plan or the switch, so an owner can always take a domain down. Removing a domain that is
 * already being removed succeeds.
 */
export async function removeCustomDomain(
  regions: Regions,
  input: { userId: string; hostname: string; now: number },
): Promise<Result<{ hostname: string }>> {
  const found = await reach(regions.global, input.userId, input.hostname, input.now);
  if (!found.ok) return found;
  const { claim, domain } = found.value;
  if (claim) {
    await regions.global
      .delete(k)
      .where(and(eq(k.hostname, claim.hostname), eq(k.ownerId, claim.ownerId)));
  }
  if (domain) {
    await detachDomain(
      domainDbs(regions),
      domain.hostname,
      "removed",
      input.now,
      { ownerId: domain.ownerId },
      { type: "user", id: input.userId },
    );
  }
  return ok({ hostname: (claim ?? (domain as DomainRow)).hostname });
}

export interface DomainListing {
  available: boolean;
  enabled: boolean;
  limit: number;
  used: number;
  domains: DomainRecord[];
}

async function listing(
  global: Db,
  deps: DomainDeps | null,
  ownerId: string,
  owner: Entitlements,
  where: { artifactId?: string },
  now: number,
): Promise<DomainListing> {
  const rows = await global
    .select()
    .from(c)
    .where(eq(c.ownerId, ownerId))
    .orderBy(asc(c.verifiedAt), asc(c.hostname));
  const claims = await global
    .select()
    .from(k)
    .where(and(eq(k.ownerId, ownerId), sql`${k.expiresAt} > ${now}`))
    .orderBy(asc(k.createdAt), asc(k.hostname));
  const domains = [
    ...rows.map(domainRecord),
    ...claims
      .filter((claim) => !rows.some((row) => row.hostname === claim.hostname))
      .map((claim) => claimRecord(claim)),
  ].filter((record) => where.artifactId === undefined || record.artifactId === where.artifactId);
  return {
    available: deps !== null,
    enabled: owner.features.includes("customDomains"),
    limit: domainLimit(owner),
    used: rows.filter((row) => row.state !== "detaching").length,
    domains,
  };
}

/** Every domain and pending claim of the actor's owner. Never behind the plan. */
export async function listCustomDomains(
  regions: Regions,
  deps: DomainDeps | null,
  input: { actor: Actor; now: number },
): Promise<Result<DomainListing>> {
  const allowed = authorize(input.actor, "access");
  if (!allowed.ok) return allowed;
  const owner = entitlements(await planRow(regions.global, input.actor.ownerId), input.now);
  return ok(await listing(regions.global, deps, input.actor.ownerId, owner, {}, input.now));
}

/**
 * The domain and pending claims of one artifact, with its owner's plan: what the dashboard's
 * artifact settings show. A user with no role on the owner gets the missing-artifact answer.
 */
export async function artifactCustomDomains(
  regions: Regions,
  deps: DomainDeps | null,
  input: { userId: string; artifactId: string; now: number },
): Promise<Result<DomainListing>> {
  const handles = await artifactHandles(regions, input.artifactId);
  if (!handles) return missingArtifact();
  const artifact = await loadArtifact(handles.db, input.artifactId);
  if (!artifact) return missingArtifact();
  const actor = await authorizeOn(
    handles.db,
    input.userId,
    artifact.ownerId,
    "access",
    missingArtifact,
  );
  if (!actor.ok) return actor;
  const owner = entitlements(await planRow(regions.global, artifact.ownerId), input.now);
  return ok(
    await listing(
      regions.global,
      deps,
      artifact.ownerId,
      owner,
      { artifactId: artifact.id },
      input.now,
    ),
  );
}

async function planRow(global: Db, ownerId: string) {
  const [row] = await global
    .select({
      plan: schema.ownerPlans.plan,
      seats: schema.ownerPlans.seats,
      validUntil: schema.ownerPlans.validUntil,
      overrides: schema.ownerPlans.overrides,
    })
    .from(schema.ownerPlans)
    .where(eq(schema.ownerPlans.ownerId, ownerId))
    .limit(1);
  return row ?? null;
}

/**
 * Detaches every domain of one artifact and drops its claims: suspension, purge. Reinstating a
 * suspended artifact does not bring a domain back; the owner proves it again.
 */
export async function releaseArtifactDomains(
  dbs: DomainDbs,
  artifactId: string,
  reason: DetachReason,
  now: number,
): Promise<number> {
  const rows = await dbs.global
    .select({ hostname: c.hostname })
    .from(c)
    .where(and(eq(c.artifactId, artifactId), ne(c.state, "detaching")));
  let detached = 0;
  for (const { hostname } of rows) {
    if (await detachDomain(dbs, hostname, reason, now, { artifactId })) detached += 1;
  }
  await dbs.global.delete(k).where(eq(k.artifactId, artifactId));
  return detached;
}

/** Detaches every domain of an owner and drops its claims: account or workspace deletion. */
export async function releaseOwnerDomains(
  dbs: DomainDbs,
  ownerId: string,
  reason: DetachReason,
  now: number,
): Promise<number> {
  const rows = await dbs.global
    .select({ hostname: c.hostname })
    .from(c)
    .where(and(eq(c.ownerId, ownerId), ne(c.state, "detaching")));
  let detached = 0;
  for (const { hostname } of rows) {
    if (await detachDomain(dbs, hostname, reason, now, { ownerId })) detached += 1;
  }
  await dbs.global.delete(k).where(eq(k.ownerId, ownerId));
  return detached;
}

export interface DomainCheckResult {
  prunedClaims: number;
  activated: number;
  checked: number;
  detached: number;
  /** Owners scheduled a downgrade notice. */
  notices: number;
}

/**
 * The scheduled check (every run of the jobs Worker, bounded): prunes expired claims, brings
 * `provisioning` domains forward, re-checks each active domain once a day and applies lower
 * plan limits. Without Cloudflare (the feature switched off) only the parts that need no call
 * run. Every step is guarded on the row it read, so overlapping runs are safe.
 */
export async function checkCustomDomains(
  dbs: DomainDbs,
  deps: DomainDeps | null,
  now: number,
  batch = DOMAIN_CHECK_BATCH,
): Promise<DomainCheckResult> {
  const result: DomainCheckResult = {
    prunedClaims: 0,
    activated: 0,
    checked: 0,
    detached: 0,
    notices: 0,
  };
  const expired = await dbs.global
    .delete(k)
    .where(
      sql`rowid in (select rowid from ${k} where ${k.expiresAt} <= ${now} limit ${PRUNE_BATCH})`,
    )
    .returning({ hostname: k.hostname });
  result.prunedClaims = expired.length;

  if (deps) {
    for (const row of await dbs.global
      .select()
      .from(c)
      .where(eq(c.state, "provisioning"))
      .orderBy(asc(c.checkedAt))
      .limit(batch)) {
      const after = await provision(dbs, deps, row, now);
      if (after.state === "active") result.activated += 1;
      if (after.state === "detaching") result.detached += 1;
    }
    for (const row of await dbs.global
      .select()
      .from(c)
      .where(
        and(eq(c.state, "active"), lte(c.checkedAt, now - CUSTOM_DOMAINS.recheckHours * 3_600_000)),
      )
      .orderBy(asc(c.checkedAt))
      .limit(batch)) {
      if (!recheckDue(row.checkedAt, now)) continue;
      result.checked += 1;
      if (await recheck(dbs, deps, row, now)) result.detached += 1;
    }
  }
  result.detached += await enforceDomainLimits(dbs, now);
  result.notices = await scheduleDomainNotices(dbs.global, now);
  return result;
}

/** The daily check of an active domain. True when it detached it. */
async function recheck(dbs: DomainDbs, deps: DomainDeps, row: DomainRow, now: number) {
  if (isBlockedHostname(row.hostname, await blockedNames(dbs.global))) {
    return detachDomain(dbs, row.hostname, "blocked", now, { artifactId: row.artifactId });
  }
  const [artifact] = await dbs
    .regional(row.region)
    .select({ state: a.state, customHost: a.customHost, ownerId: a.ownerId })
    .from(a)
    .where(eq(a.id, row.artifactId))
    .limit(1);
  // An active row whose artifact never took the host (a Worker stopped inside `activate`) binds
  // it now, under the same conditions.
  if (
    artifact &&
    artifact.customHost === null &&
    artifact.ownerId === row.ownerId &&
    artifact.state === "active" &&
    (await bindHost(dbs.regional(row.region), row))
  ) {
    artifact.customHost = row.hostname;
  }
  // An archived artifact keeps its domain (restoring it serves it again); anything else that
  // stopped holding the host gives the name up.
  if (
    !artifact ||
    artifact.customHost !== row.hostname ||
    artifact.ownerId !== row.ownerId ||
    (artifact.state !== "active" && artifact.state !== "archived")
  ) {
    return detachDomain(dbs, row.hostname, "artifact_unavailable", now, {
      artifactId: row.artifactId,
    });
  }
  const values = await lookupTxt(deps, row.hostname);
  const txt =
    values === null ? "unknown" : holdsTxt(values, txtRecordValue(row.token)) ? "held" : "missing";
  let cloudflare: Awaited<ReturnType<DomainDeps["hostnames"]["status"]>> | "unknown" = "unknown";
  if (row.cfHostnameId !== null) {
    try {
      cloudflare = await deps.hostnames.status(row.cfHostnameId);
    } catch {
      cloudflare = "unknown";
    }
  } else {
    cloudflare = "missing";
  }
  const decision = checkProvenDomain({ missedChecks: row.missedChecks, txt, cloudflare });
  if (decision.action === "detach") {
    return detachDomain(dbs, row.hostname, decision.reason, now, { artifactId: row.artifactId });
  }
  const pointing = await lookupPointing(deps, row.hostname);
  const points = checkPointing({ missedPointChecks: row.missedPointChecks, pointing });
  if (points.action === "detach") {
    return detachDomain(dbs, row.hostname, points.reason, now, { artifactId: row.artifactId });
  }
  const problem: CustomDomainProblem | null =
    txt === "missing"
      ? "txt_missing"
      : pointing === "elsewhere"
        ? "cname_elsewhere"
        : cloudflare === "unknown"
          ? "cloudflare_unavailable"
          : null;
  await dbs.global
    .update(c)
    .set({
      missedChecks: decision.missedChecks,
      missedPointChecks: points.missedPointChecks,
      checkedAt: now,
      problem,
    })
    .where(and(eq(c.hostname, row.hostname), eq(c.state, "active"), eq(c.token, row.token)));
  return false;
}

/**
 * Owners with more domains than their plan allows keep the oldest. An expired plan counts as it
 * was for `downgradeGraceDays` more (`domainLimitAt`), so an owner has a week to renew.
 */
export async function enforceDomainLimits(dbs: DomainDbs, now: number): Promise<number> {
  const owners = await dbs.global
    .select({ ownerId: c.ownerId, n: sql<number>`count(*)` })
    .from(c)
    .where(ne(c.state, "detaching"))
    .groupBy(c.ownerId);
  let detached = 0;
  for (let i = 0; i < owners.length; i += IN_CHUNK) {
    const chunk = owners.slice(i, i + IN_CHUNK);
    const plans = new Map(
      (
        await dbs.global
          .select({
            ownerId: schema.ownerPlans.ownerId,
            plan: schema.ownerPlans.plan,
            seats: schema.ownerPlans.seats,
            validUntil: schema.ownerPlans.validUntil,
            overrides: schema.ownerPlans.overrides,
          })
          .from(schema.ownerPlans)
          .where(
            inArray(
              schema.ownerPlans.ownerId,
              chunk.map((owner) => owner.ownerId),
            ),
          )
      ).map((row) => [row.ownerId, row]),
    );
    for (const { ownerId, n } of chunk) {
      const limit = domainLimit(entitlements(plans.get(ownerId) ?? null, domainLimitAt(now)));
      if (n <= limit) continue;
      const rows = await dbs.global
        .select({ hostname: c.hostname, verifiedAt: c.verifiedAt })
        .from(c)
        .where(and(eq(c.ownerId, ownerId), ne(c.state, "detaching")));
      for (const hostname of domainsOverLimit(rows, limit)) {
        if (await detachDomain(dbs, hostname, "plan_limit", now, { ownerId })) detached += 1;
      }
    }
  }
  return detached;
}

export interface DomainReconcileResult {
  /** Rows whose Cloudflare hostname is gone or names another host: detached. */
  detached: string[];
  /** Cloudflare hostnames without a row: deleted. */
  removed: string[];
  /** Artifacts that held a host without an active domain row: cleared. */
  cleared: string[];
}

/**
 * After a D1 Time Travel restore, Cloudflare is the record of which hostnames exist (operator
 * `reconcile-domains`): a row whose Cloudflare hostname is gone or names another host is
 * detached, a Cloudflare hostname without a row is deleted, and an artifact that holds a host no
 * active row gives it to stops holding it. Rows still provisioning without a Cloudflare ID are
 * left to the scheduled check.
 */
export async function reconcileCustomDomains(
  dbs: DomainDbs,
  regionals: readonly Db[],
  deps: DomainDeps,
  now: number,
): Promise<DomainReconcileResult> {
  const live = new Map((await deps.hostnames.list()).map((entry) => [entry.id, entry.hostname]));
  const rows = await dbs.global.select().from(c);
  const result: DomainReconcileResult = { detached: [], removed: [], cleared: [] };
  const known = new Set<string>();
  for (const row of rows) {
    if (row.cfHostnameId === null) continue;
    known.add(row.cfHostnameId);
    if (row.state !== "detaching" && live.get(row.cfHostnameId) !== row.hostname) {
      if (await detachDomain(dbs, row.hostname, "reconciled", now)) {
        result.detached.push(row.hostname);
      }
    }
  }
  for (const [id, hostname] of live) {
    if (known.has(id)) continue;
    await deps.hostnames.remove(id);
    result.removed.push(hostname);
  }
  const active = new Map(
    (await dbs.global.select().from(c).where(eq(c.state, "active"))).map((row) => [
      row.hostname,
      row.artifactId,
    ]),
  );
  for (const regional of regionals) {
    for (const artifact of await regional
      .select({ id: a.id, customHost: a.customHost })
      .from(a)
      .where(isNotNull(a.customHost))) {
      const host = artifact.customHost as string;
      if (active.get(host) === artifact.id) continue;
      await clearHost(regional, artifact.id, host);
      result.cleared.push(host);
    }
  }
  return result;
}

/** An owner's domains and live claims per artifact, for the account export. */
export async function exportOwnerDomains(
  global: Db,
  ownerId: string,
  now: number,
): Promise<
  Map<string, { hostname: string; state: CustomDomainState; verifiedAt: number | null }[]>
> {
  const listingOf = await listing(global, null, ownerId, entitlements(null, now), {}, now);
  const byArtifact = new Map<
    string,
    { hostname: string; state: CustomDomainState; verifiedAt: number | null }[]
  >();
  for (const record of listingOf.domains) {
    byArtifact.set(record.artifactId, [
      ...(byArtifact.get(record.artifactId) ?? []),
      { hostname: record.hostname, state: record.state, verifiedAt: record.verifiedAt },
    ]);
  }
  return byArtifact;
}

/**
 * The artifact's active custom host, or null: the regional `custom_host` is the authority, and
 * the global row must agree (active, same artifact), so a host left behind by a restore or a
 * race is never used. For the app's entries, which choose where a code goes; two indexed reads,
 * none while custom domains are switched off.
 */
export async function activeCustomHost(
  db: RegionalDb,
  artifactId: string,
  /** Whether this Worker serves custom hosts (`customDomainsServing`); off means `.dev` only. */
  enabled: boolean,
): Promise<string | null> {
  if (!enabled) return null;
  const [artifact] = await db
    .select({ customHost: a.customHost })
    .from(a)
    .where(eq(a.id, artifactId))
    .limit(1);
  const host = artifact?.customHost ?? null;
  if (host === null) return null;
  const [row] = await db.global
    .select({ hostname: c.hostname })
    .from(c)
    .where(and(eq(c.hostname, host), eq(c.state, "active"), eq(c.artifactId, artifactId)))
    .limit(1);
  return row ? host : null;
}

/** Where a custom host points, from the global table: the content Worker's hint. */
export async function customHostHint(
  global: Db,
  hostname: string,
): Promise<{ artifactId: string; region: Region } | null> {
  const [row] = await global
    .select({ artifactId: c.artifactId, region: c.region })
    .from(c)
    .where(and(eq(c.hostname, hostname), eq(c.state, "active")))
    .limit(1);
  return row ?? null;
}

/**
 * Operator: blocks a name (and every name under it) as a custom domain, detaches the domains it
 * covers and drops their claims. Returns the normalized name and the hostnames detached.
 */
export async function blockHostname(
  dbs: DomainDbs,
  input: { name: string; note?: string | undefined; now: number },
): Promise<Result<{ name: string; detached: string[] }>> {
  const name = normalizeBlockName(input.name);
  if (name === null) return fail("invalid_input", "That is not a hostname.");
  await dbs.global
    .insert(schema.blockedHostnames)
    .values({ name, note: input.note ?? null, createdAt: input.now })
    .onConflictDoUpdate({
      target: schema.blockedHostnames.name,
      set: { note: input.note ?? null },
    });
  const covered = (
    await dbs.global
      .select({ hostname: c.hostname })
      .from(c)
      .where(
        and(
          ne(c.state, "detaching"),
          sql`(${c.hostname} = ${name} or ${c.hostname} like ${`%.${name}`})`,
        ),
      )
  ).map((row) => row.hostname);
  const detached: string[] = [];
  for (const hostname of covered) {
    if (await detachDomain(dbs, hostname, "blocked", input.now)) detached.push(hostname);
  }
  await dbs.global
    .delete(k)
    .where(sql`(${k.hostname} = ${name} or ${k.hostname} like ${`%.${name}`})`);
  return ok({ name, detached });
}

/** Operator: lifts a block. Domains it detached stay detached; their owners add them again. */
export async function unblockHostname(global: Db, name: string): Promise<boolean> {
  const normalized = normalizeBlockName(name);
  if (normalized === null) return false;
  const deleted = await global
    .delete(schema.blockedHostnames)
    .where(eq(schema.blockedHostnames.name, normalized))
    .returning({ name: schema.blockedHostnames.name });
  return deleted.length > 0;
}

/** Operator: the block list, oldest first. */
export async function listBlockedHostnames(global: Db) {
  return global
    .select()
    .from(schema.blockedHostnames)
    .orderBy(asc(schema.blockedHostnames.createdAt), asc(schema.blockedHostnames.name));
}
