// Single sign-on with OpenID Connect for a workspace (premium plan E1, decision 0016): managing
// the provider, the login page's lookup, what a sign-in may assert and joining the workspace.
// The protocol itself (state, PKCE, nonce, ID token) is in apps/app/src/auth/sso.ts over Better
// Auth; everything that decides who may sign in, and as whom, is here.
//
// The provider speaks only for the workspace's verified email domains (decision 0010) that it
// serves, re-read at every sign-in, while the workspace's plan includes `sso`. Its
// `email_verified` claim is never read: the domain proof is what proves control of the address.
import {
  SSO_LIMITS,
  type SsoDiscoveryProblem,
  type SsoState,
  type SsoTestResult,
  type WorkspaceRole,
} from "@portifact/contracts";
import { type GlobalDb, hitRateLimit, schema } from "@portifact/db";
import {
  checkDiscovery,
  checkSsoDomains,
  checkSsoIssuer,
  discoveryUrl,
  emailDomainOf,
  fail,
  liveSsoDomains,
  normalizeEmail,
  ok,
  type Result,
  requireFeature,
  type SsoAccountPlan,
  type SsoEndpoints,
  ssoAccountDecision,
  ssoServesEmail,
} from "@portifact/domain";
import { and, eq, gt, type SQL, sql } from "drizzle-orm";
import { auditEvent } from "./audit.ts";
import { seatLimit } from "./invitations.ts";
import { hex } from "./objects.ts";
import { ownerEntitlements } from "./plans.ts";
import { joinGroupStatements, linkDirectoryUser } from "./scim-groups.ts";
import { openSsoSecret, type SsoKey, sealSsoSecret } from "./sso-keys.ts";
import { ssoSuspensionStatements } from "./sso-required.ts";
import { memberEvent, scoped, seatsUsedSql, stillAdmin } from "./workspaces.ts";

const so = schema.workspaceSso;
const wd = schema.workspaceDomains;
const m = schema.workspaceMembers;
const inv = schema.workspaceInvitations;

/** Fetches what the identity provider serves; Workers' fetch, or a fake in tests. */
export type SsoFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Better Auth's `accounts.provider_id` of identities linked through a provider. */
export function ssoAccountProvider(providerId: string): string {
  return `sso:${providerId}`;
}

export function newSsoProviderId(): string {
  return `sso_${hex(crypto.getRandomValues(new Uint8Array(16)).buffer)}`;
}

export interface SsoProviderRow {
  id: string;
  workspaceId: string;
  issuer: string;
  clientId: string;
  domains: string[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}

function parseDomains(text: string): string[] {
  return text.split(" ").filter((domain) => domain !== "");
}

async function providerOf(global: GlobalDb, workspaceId: string) {
  const [row] = await global.select().from(so).where(eq(so.workspaceId, workspaceId)).limit(1);
  return row ?? null;
}

function rowView(row: typeof so.$inferSelect): SsoProviderRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    issuer: row.issuer,
    clientId: row.clientId,
    domains: parseDomains(row.domains),
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function verifiedDomains(global: GlobalDb, workspaceId: string): Promise<string[]> {
  const rows = await global
    .select({ domain: wd.domain })
    .from(wd)
    .where(and(eq(wd.workspaceId, workspaceId), eq(wd.state, "verified")));
  return rows.map((row) => row.domain).sort();
}

// The identity provider's answers --------------------------------------------------------------

export type Fetched =
  | { ok: true; value: unknown }
  | { ok: false; problem: SsoDiscoveryProblem; status?: number };

/** Reads at most `limit` bytes of a body as text, or null when it is longer. */
async function readBounded(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) return null;
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * One call to the identity provider: no redirects followed, at most `SSO_LIMITS.fetchTimeoutMs`
 * for the whole answer and at most `SSO_LIMITS.responseMaxBytes` read, parsed as JSON. Never logs
 * the URL's path, the body sent or the answer: they can hold codes and tokens.
 */
export async function fetchSsoJson(
  fetch: SsoFetch,
  url: string,
  init: RequestInit = {},
): Promise<Fetched> {
  const signal = AbortSignal.timeout(SSO_LIMITS.fetchTimeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal,
      headers: { accept: "application/json", ...(init.headers as Record<string, string>) },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, problem: "redirect", status: response.status };
    }
    const text = await Promise.race([
      readBounded(response, SSO_LIMITS.responseMaxBytes),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
    if (text === null) return { ok: false, problem: "too_large" };
    if (!response.ok) return { ok: false, problem: "http_error", status: response.status };
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, problem: "not_json" };
    }
  } catch {
    return { ok: false, problem: signal.aborted ? "timeout" : "unreachable" };
  }
}

/** Entries each isolate cache of the identity providers' answers keeps (discovery, key sets). */
export const SSO_CACHE_ENTRIES = 64;

/** Sets a cache entry, evicting the oldest beyond `SSO_CACHE_ENTRIES`. */
export function boundedSet<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > SSO_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

const discoveryCache = new Map<string, { at: number; endpoints: SsoEndpoints }>();

/** How many issuers the isolate's discovery cache holds; tests check the bound. */
export function ssoDiscoveryCacheSize(): number {
  return discoveryCache.size;
}

/**
 * Fetches and checks the issuer's discovery document. Sign-ins reuse a checked document for
 * `SSO_LIMITS.cacheSeconds` in the isolate; the admin's test and saving always fetch it again.
 */
export async function discoverSso(
  fetch: SsoFetch,
  issuer: string,
  options: { now: number; fresh?: boolean },
): Promise<{ ok: true; value: SsoEndpoints } | { ok: false; problem: SsoDiscoveryProblem }> {
  const cached = discoveryCache.get(issuer);
  if (!options.fresh && cached && options.now - cached.at < SSO_LIMITS.cacheSeconds * 1000) {
    return { ok: true, value: cached.endpoints };
  }
  const fetched = await fetchSsoJson(fetch, discoveryUrl(issuer));
  if (!fetched.ok) return { ok: false, problem: fetched.problem };
  const checked = checkDiscovery(fetched.value, issuer);
  if (checked.ok) boundedSet(discoveryCache, issuer, { at: options.now, endpoints: checked.value });
  return checked;
}

/** Drops cached discovery documents; tests use it between cases. */
export function clearSsoDiscoveryCache(): void {
  discoveryCache.clear();
}

// Managing the provider (admins, dashboard session only) ---------------------------------------

export interface SsoSettingsResult {
  state: SsoState;
  provider: (SsoProviderRow & { lapsedDomains: string[] }) | null;
  available: boolean;
  verifiedDomains: string[];
}

function stateOf(
  provider: SsoProviderRow | null,
  available: boolean,
  live: readonly string[],
): SsoState {
  if (!provider) return "off";
  if (!available) return "plan";
  return live.length === 0 ? "domains" : "on";
}

/** The workspace's provider, its state and the domains it may serve, for an admin. */
export async function getSsoSettings(
  global: GlobalDb,
  input: { userId: string; slug: string; now: number },
): Promise<Result<SsoSettingsResult>> {
  const found = await scoped(global, input.userId, input.slug, "sso");
  if (!found.ok) return found;
  const { workspace } = found.value;
  const available = requireFeature(
    await ownerEntitlements(global, workspace.id, input.now),
    "sso",
  ).ok;
  const verified = await verifiedDomains(global, workspace.id);
  const row = await providerOf(global, workspace.id);
  const provider = row ? rowView(row) : null;
  const live = provider ? liveSsoDomains(provider.domains, verified) : [];
  return ok({
    state: stateOf(provider, available, live),
    provider: provider
      ? { ...provider, lapsedDomains: provider.domains.filter((d) => !live.includes(d)) }
      : null,
    available,
    verifiedDomains: verified,
  });
}

const DISCOVERY_MESSAGES: Record<SsoDiscoveryProblem, string> = {
  invalid_issuer: "The issuer URL is not valid.",
  unreachable: "The identity provider could not be reached.",
  timeout: "The identity provider took too long to answer.",
  redirect: "The identity provider answered with a redirect, which is not followed.",
  http_error: "The identity provider answered with an error.",
  too_large: "The identity provider's answer is too large.",
  not_json: "The identity provider's discovery document is not valid JSON.",
  issuer_mismatch: "The discovery document names a different issuer.",
  missing_endpoint: "The discovery document lacks an endpoint Portifact needs.",
  invalid_endpoint: "An endpoint in the discovery document is not a public https URL.",
  no_code_flow: "The identity provider does not offer the authorization code flow.",
  no_pkce: "The identity provider does not support PKCE with S256.",
  no_signing_algorithm:
    "The identity provider signs ID tokens with no algorithm Portifact accepts.",
};

/** The rate limit of discovery calls an admin's test and saving make, per workspace. */
async function discoveryAllowed(global: GlobalDb, workspaceId: string, now: number) {
  const hit = await hitRateLimit(global.$client, `sso:discovery:${workspaceId}`, 3_600_000, now);
  return hit.count <= 30;
}

/**
 * Runs discovery for an issuer and reports what failed, for an admin on a plan with `sso`. It
 * stores nothing.
 */
export async function testSsoIssuer(
  global: GlobalDb,
  fetch: SsoFetch,
  input: { userId: string; slug: string; issuer: string; now: number },
): Promise<Result<SsoTestResult>> {
  const found = await scoped(global, input.userId, input.slug, "sso");
  if (!found.ok) return found;
  const { workspace } = found.value;
  const gate = requireFeature(await ownerEntitlements(global, workspace.id, input.now), "sso");
  if (!gate.ok) return gate;
  const issuer = checkSsoIssuer(input.issuer);
  if (!issuer.ok) return ok({ ok: false, problem: "invalid_issuer" });
  if (!(await discoveryAllowed(global, workspace.id, input.now))) {
    return fail("rate_limited", "Too many checks. Wait a while and try again.");
  }
  const found2 = await discoverSso(fetch, issuer.value.issuer, { now: input.now, fresh: true });
  if (!found2.ok) return ok({ ok: false, problem: found2.problem });
  const host = (url: string) => new URL(url).hostname;
  return ok({
    ok: true,
    hosts: {
      authorization: host(found2.value.authorization),
      token: host(found2.value.token),
      keys: host(found2.value.jwks),
    },
  });
}

export interface SsoSaveInput {
  userId: string;
  slug: string;
  issuer: string;
  clientId: string;
  /** Omitted on a change to keep the stored one; required on creation. */
  clientSecret?: string | undefined;
  domains: string[];
  now: number;
}

/**
 * Creates or changes the workspace's provider, for an admin on a plan with `sso`. The issuer must
 * pass discovery; the issuer of an existing provider cannot change. The secret is sealed with
 * the current `SSO_KEY`; without one, saving answers `capacity_unavailable`. The batch holds only
 * while the caller is still an admin and, on a change, the revision is the one read, and records
 * `sso.created` or `sso.changed` (never the client ID or secret).
 */
export async function saveSsoProvider(
  global: GlobalDb,
  deps: { keys: readonly SsoKey[]; fetch: SsoFetch },
  input: SsoSaveInput,
): Promise<Result<SsoProviderRow>> {
  const found = await scoped(global, input.userId, input.slug, "sso");
  if (!found.ok) return found;
  const { workspace } = found.value;
  const gate = requireFeature(await ownerEntitlements(global, workspace.id, input.now), "sso");
  if (!gate.ok) return gate;
  const key = deps.keys[0];
  if (!key) return fail("capacity_unavailable", "Single sign-on is unavailable right now.");

  const existing = await providerOf(global, workspace.id);
  const issuer = checkSsoIssuer(input.issuer);
  if (!issuer.ok) return issuer;
  if (existing && existing.issuer !== issuer.value.issuer) {
    return fail(
      "invalid_input",
      "The issuer cannot change. Remove single sign-on and set it up again for a new issuer.",
    );
  }
  if (!existing && input.clientSecret === undefined) {
    return fail("invalid_input", "Enter the client secret.");
  }
  const domains = checkSsoDomains(input.domains, await verifiedDomains(global, workspace.id));
  if (!domains.ok) return domains;
  if (!(await discoveryAllowed(global, workspace.id, input.now))) {
    return fail("rate_limited", "Too many checks. Wait a while and try again.");
  }
  const discovered = await discoverSso(deps.fetch, issuer.value.issuer, {
    now: input.now,
    fresh: true,
  });
  if (!discovered.ok) return fail("invalid_input", DISCOVERY_MESSAGES[discovered.problem]);

  const sealed =
    input.clientSecret === undefined
      ? null
      : await sealSsoSecret(key, workspace.id, input.clientSecret);
  const domainText = domains.value.join(" ");
  const actor = { type: "user" as const, id: input.userId };
  const admin = stillAdmin(workspace.id, input.userId);

  if (!existing) {
    const id = newSsoProviderId();
    const [, inserted] = await global.batch([
      auditEvent(
        global,
        {
          ownerId: workspace.id,
          kind: "sso.created",
          actor,
          targetId: id,
          detail: { issuerHost: issuer.value.host, domains: domains.value.length },
          now: input.now,
        },
        sql`${admin} and not exists (select 1 from ${so} where ${so.workspaceId} = ${workspace.id})`,
      ),
      global
        .insert(so)
        // Columns in schema order.
        .select(
          sql`select ${id}, ${workspace.id}, ${issuer.value.issuer}, ${input.clientId}, ${sealed}, ${key.id}, ${domainText}, 1, ${input.now}, ${input.now} where ${admin}`,
        )
        .onConflictDoNothing()
        .returning({ id: so.id }),
    ]);
    if (inserted.length === 0) return conflictOrScope(global, input);
    const row = await providerOf(global, workspace.id);
    return row ? ok(rowView(row)) : conflictOrScope(global, input);
  }

  const fields: ("clientId" | "clientSecret" | "domains")[] = [];
  if (existing.clientId !== input.clientId) fields.push("clientId");
  if (sealed !== null) fields.push("clientSecret");
  if (existing.domains !== domainText) fields.push("domains");
  if (fields.length === 0) return ok(rowView(existing));
  const target = and(eq(so.id, existing.id), eq(so.revision, existing.revision), admin) as SQL;
  const [, updated] = await global.batch([
    auditEvent(
      global,
      {
        ownerId: workspace.id,
        kind: "sso.changed",
        actor,
        targetId: existing.id,
        detail: { fields },
        now: input.now,
      },
      sql`exists (select 1 from ${so} where ${target})`,
    ),
    global
      .update(so)
      .set({
        clientId: input.clientId,
        ...(sealed === null ? {} : { clientSecretSealed: sealed, secretKeyId: key.id }),
        domains: domainText,
        revision: existing.revision + 1,
        updatedAt: input.now,
      })
      .where(target)
      .returning({ id: so.id }),
    // The served domains changed: "SSO required" may be suspended or resumed (decision 0021).
    ...ssoSuspensionStatements(global, {
      workspaceId: workspace.id,
      now: input.now,
      cause: "provider",
    }),
  ]);
  if (updated.length === 0) return conflictOrScope(global, input);
  return ok(
    rowView({
      ...existing,
      clientId: input.clientId,
      domains: domainText,
      revision: existing.revision + 1,
      updatedAt: input.now,
    }),
  );
}

async function conflictOrScope(
  global: GlobalDb,
  input: { userId: string; slug: string },
): Promise<Result<never>> {
  const again = await scoped(global, input.userId, input.slug, "sso");
  return again.ok
    ? fail("version_conflict", "Single sign-on changed meanwhile. Try again.")
    : again;
}

/**
 * Removes the workspace's provider, for an admin, whatever the plan: the row, the identities
 * linked through it (people keep their accounts and sign in another way) and a `workspace_sso`
 * tombstone in one batch, so a restore cannot bring it back. Members stay members. A policy that
 * required single sign-on through it stops requiring it in the same batch (decision 0021).
 */
export async function removeSsoProvider(
  global: GlobalDb,
  input: { userId: string; slug: string; now: number },
): Promise<Result<true>> {
  const found = await scoped(global, input.userId, input.slug, "sso");
  if (!found.ok) return found;
  const { workspace } = found.value;
  const row = await providerOf(global, workspace.id);
  if (!row) return fail("not_found", "Single sign-on is not set up.");
  const target = and(eq(so.id, row.id), stillAdmin(workspace.id, input.userId)) as SQL;
  const exists = sql`exists (select 1 from ${so} where ${target})`;
  // "SSO required" (decision 0021) names this provider: it is cleared in the same batch, by the
  // system and recorded, so no workspace keeps a requirement nobody can meet.
  const ws = schema.workspaces;
  const requires = sql`${exists} and exists (select 1 from ${ws} where ${ws.id} = ${workspace.id} and coalesce(json_extract(${ws.policy}, '$.ssoRequired'), 0) = 1)`;
  const [, , , , , deleted] = await global.batch([
    auditEvent(
      global,
      {
        ownerId: workspace.id,
        kind: "policy.changed",
        actor: { type: "system" },
        targetId: workspace.id,
        detail: {
          fields: ["ssoRequired"],
          ssoRequired: false,
          reason: "sso_removed",
          confirmed: false,
        },
        now: input.now,
      },
      requires,
    ),
    global
      .update(ws)
      .set({
        policy: sql`json_remove(${ws.policy}, '$.ssoRequired')`,
        policyRevision: sql`${ws.policyRevision} + 1`,
        ssoSuspended: 0,
        updatedAt: input.now,
      })
      .where(and(eq(ws.id, workspace.id), requires) as SQL),
    auditEvent(
      global,
      {
        ownerId: workspace.id,
        kind: "sso.removed",
        actor: { type: "user", id: input.userId },
        targetId: row.id,
        detail: {},
        now: input.now,
      },
      exists,
    ),
    global
      .insert(schema.tombstones)
      .select(sql`select 'workspace_sso', ${so.id}, ${input.now} from ${so} where ${target}`)
      .onConflictDoNothing(),
    global
      .delete(schema.accounts)
      .where(and(eq(schema.accounts.providerId, ssoAccountProvider(row.id)), exists) as SQL),
    global.delete(so).where(target).returning({ id: so.id }),
  ]);
  if (deleted.length > 0) return ok(true);
  const again = await scoped(global, input.userId, input.slug, "sso");
  return again.ok ? ok(true) : again;
}

// Signing in -----------------------------------------------------------------------------------

/** A provider that may sign people in right now, without its secret. */
export interface SsoSignInProvider {
  id: string;
  workspaceId: string;
  issuer: string;
  clientId: string;
  revision: number;
  /** Its served domains still verified. */
  liveDomains: string[];
}

async function signInProvider(
  global: GlobalDb,
  row: typeof so.$inferSelect,
  now: number,
): Promise<SsoSignInProvider | null> {
  const gate = requireFeature(await ownerEntitlements(global, row.workspaceId, now), "sso");
  if (!gate.ok) return null;
  const live = liveSsoDomains(
    parseDomains(row.domains),
    await verifiedDomains(global, row.workspaceId),
  );
  if (live.length === 0) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    issuer: row.issuer,
    clientId: row.clientId,
    revision: row.revision,
    liveDomains: live,
  };
}

/**
 * The provider that signs in an address, if any: the workspace that verified the address's
 * domain (at most one, decision 0010) has a provider serving it and a plan with `sso`.
 */
export async function ssoProviderForEmail(
  global: GlobalDb,
  email: string,
  now: number,
): Promise<SsoSignInProvider | null> {
  const domain = emailDomainOf(normalizeEmail(email));
  if (domain === null) return null;
  const [row] = await global
    .select({ provider: so })
    .from(wd)
    .innerJoin(so, eq(so.workspaceId, wd.workspaceId))
    .where(and(eq(wd.domain, domain), eq(wd.state, "verified")))
    .limit(1);
  if (!row || !parseDomains(row.provider.domains).includes(domain)) return null;
  const provider = await signInProvider(global, row.provider, now);
  return provider && ssoServesEmail(email, provider.liveDomains) ? provider : null;
}

/**
 * The provider a callback names, with its client secret, if it may still sign people in and has
 * not changed since `revision` (a change or a removal mid-flow refuses the sign-in).
 */
export async function ssoProviderForCallback(
  global: GlobalDb,
  keys: readonly SsoKey[],
  providerId: string,
  revision: number,
  now: number,
): Promise<(SsoSignInProvider & { clientSecret: string }) | null> {
  const [row] = await global.select().from(so).where(eq(so.id, providerId)).limit(1);
  if (!row || row.revision !== revision) return null;
  const provider = await signInProvider(global, row, now);
  if (!provider) return null;
  const clientSecret = await openSsoSecret(
    keys,
    row.secretKeyId,
    row.workspaceId,
    row.clientSecretSealed,
  );
  return clientSecret === null ? null : { ...provider, clientSecret };
}

/**
 * Which account a verified identity signs in to, or why not (decision 0016, section 3): its
 * address must be in a live domain of the provider, as must the address of an account already
 * linked to it, and the account plan comes from `ssoAccountDecision`. Messages are the login
 * page's codes (`sso_email_outside_domain`, `sso_link_required`).
 */
export async function checkSsoIdentity(
  global: GlobalDb,
  input: {
    provider: SsoSignInProvider;
    email: string;
    subject: string;
    emailVerified: true | undefined;
    sessionUserId: string | null;
  },
): Promise<Result<SsoAccountPlan>> {
  const outside = () => fail<never>("forbidden", "sso_email_outside_domain");
  if (!ssoServesEmail(input.email, input.provider.liveDomains)) return outside();
  const [linked] = await global
    .select({ userId: schema.users.id, email: schema.users.email })
    .from(schema.accounts)
    .innerJoin(schema.users, eq(schema.users.id, schema.accounts.userId))
    .where(
      and(
        eq(schema.accounts.providerId, ssoAccountProvider(input.provider.id)),
        eq(schema.accounts.accountId, input.subject),
      ),
    )
    .limit(1);
  if (linked && !ssoServesEmail(linked.email, input.provider.liveDomains)) return outside();
  const [existing] = await global
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${normalizeEmail(input.email)}`)
    .limit(1);
  return ssoAccountDecision({
    linkedUserId: linked?.userId ?? null,
    existingUserId: existing?.id ?? null,
    emailVerified: input.emailVerified,
    sessionUserId: input.sessionUserId,
  });
}

/** Removes an identity a sign-in linked to an account it did not plan for (a race). */
export async function unlinkSsoIdentity(
  global: GlobalDb,
  input: { providerId: string; subject: string; userId: string },
): Promise<void> {
  await global
    .delete(schema.accounts)
    .where(
      and(
        eq(schema.accounts.providerId, ssoAccountProvider(input.providerId)),
        eq(schema.accounts.accountId, input.subject),
        eq(schema.accounts.userId, input.userId),
      ),
    );
}

/**
 * Makes the person a member of the provider's workspace if they are not one (decision 0016,
 * section 5): refused with `sso_removed` while an admin's removal stands; with the role of a
 * pending invitation to their address, which is consumed in place of the accept step, only when
 * `consumeInvitation` (the provider vouched for the address, or the account is new); otherwise a
 * pending invitation is left for the accept step and nothing is joined. Without one, `member`. Only
 * while a seat is free (members and pending invitations, their own invitation's seat being the one
 * they take) and the plan row is the one read. An existing member keeps their role. Recorded as
 * `member.joined` with `via: "sso"`. Idempotent.
 */
export async function joinWorkspaceThroughSso(
  global: GlobalDb,
  input: {
    workspaceId: string;
    userId: string;
    email: string;
    now: number;
    consumeInvitation: boolean;
  },
): Promise<Result<{ joined: boolean; role: WorkspaceRole | null; pendingInvitation: boolean }>> {
  const current = async () => {
    const [row] = await global
      .select({ role: m.role })
      .from(m)
      .where(and(eq(m.workspaceId, input.workspaceId), eq(m.userId, input.userId)))
      .limit(1);
    return row ?? null;
  };
  const already = await current();
  if (already) return ok({ joined: false, role: already.role, pendingInvitation: false });
  const removed = sql`exists (select 1 from ${schema.workspaceRemovals} where ${schema.workspaceRemovals.workspaceId} = ${input.workspaceId} and ${schema.workspaceRemovals.userId} = ${input.userId})`;
  const [blocked] = await global.all<{ blocked: number }>(sql`select ${removed} as blocked`);
  if (Number(blocked?.blocked ?? 0) === 1) return fail("forbidden", "sso_removed");

  const email = normalizeEmail(input.email);
  const [invitation] = await global
    .select({ id: inv.id, role: inv.role })
    .from(inv)
    .where(
      and(
        eq(inv.workspaceId, input.workspaceId),
        eq(inv.email, email),
        gt(inv.expiresAt, input.now),
      ),
    )
    .limit(1);
  if (invitation && !input.consumeInvitation) {
    return ok({ joined: false, role: null, pendingInvitation: true });
  }
  const role: WorkspaceRole = invitation?.role ?? "member";
  const { limit, guard } = await seatLimit(global, input.workspaceId, input.now);
  const member = sql`exists (select 1 from ${m} where ${m.workspaceId} = ${input.workspaceId} and ${m.userId} = ${input.userId})`;
  const active = sql`not exists (select 1 from ${schema.accountDeletions} where ${schema.accountDeletions.userId} = ${input.userId})`;
  const invited = invitation
    ? sql`exists (select 1 from ${inv} where ${inv.id} = ${invitation.id} and ${inv.expiresAt} > ${input.now})`
    : sql`1`;
  const own = invitation ? 1 : 0;
  const joins = sql`not ${member} and not ${removed} and ${active} and ${invited} and ${seatsUsedSql(input.workspaceId, input.now, true)} - ${own} < ${limit} and ${guard}`;
  const statements = [
    memberEvent(
      global,
      {
        workspaceId: input.workspaceId,
        memberId: input.userId,
        now: input.now,
        actor: { type: "user", id: input.userId },
      },
      "member.joined",
      { role, via: "sso" },
      joins,
    ),
    global
      .insert(m)
      // Columns in schema order: workspace, user, role, created at, updated at.
      .select(
        sql`select ${input.workspaceId}, ${input.userId}, ${role}, ${input.now}, ${input.now} where ${joins}`,
      )
      .onConflictDoNothing()
      .returning({ userId: m.userId }),
  ] as const;
  // A person the workspace's directory knows gets its groups and their role in this batch.
  const directory = [
    linkDirectoryUser(global, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      condition: sql`1`,
    }),
    ...joinGroupStatements(global, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      actor: { type: "user", id: input.userId },
      now: input.now,
      condition: sql`1`,
    }),
  ];
  const [, inserted] = (invitation
    ? await global.batch([
        ...statements,
        global.delete(inv).where(and(eq(inv.id, invitation.id), member) as SQL),
        ...directory,
      ])
    : await global.batch([...statements, ...directory])) as unknown as [unknown, unknown[]];
  if (inserted.length > 0) return ok({ joined: true, role, pendingInvitation: false });
  const now = await current();
  if (now) return ok({ joined: false, role: now.role, pendingInvitation: false });
  return fail("seats_exhausted", "The workspace has no free seat.");
}
