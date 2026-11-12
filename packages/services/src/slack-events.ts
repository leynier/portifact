// The work behind the Slack events endpoint (decision 0025): verifying a request with the
// connection's own signing secret, then, after the answer, acting on a verified event. An
// uninstall marks the connection once; a `link_shared` event is answered with at most one
// `chat.unfurl` that names public, active artifacts of the connection's own owner. Nothing about
// an event is stored, and a preview writes nothing (the only writes are the guarded attention
// marks). D1 calls, pinned in apps/app/test/slack-cost.test.ts: the connection's read (with the
// owner's plan joined when the regional database is the global one), the plan's read only with a
// separate regional database and only for links worth looking up, and one read of the artifacts.
import type { ArtifactType, Region } from "@portifact/contracts";
import { bothSides, type RegionalDb, schema } from "@portifact/db";
import {
  entitlements,
  type OwnerPlanRecord,
  openSlackCredential,
  openToAnyone,
  requireFeature,
  type SlackLinkDomains,
  type SlackPreviewOptions,
  type SlackUnfurlSource,
  slackBaseString,
  slackPreviewLinks,
  slackUnfurlBody,
} from "@portifact/domain";
import { and, eq, inArray } from "drizzle-orm";
import type { IntegrationFetch } from "./integration-clients.ts";
import { type IntegrationKey, openCredential } from "./integration-keys.ts";
import { type ConnectionRow, INTEGRATION_FEATURE, markAttention } from "./integrations.ts";
import { ownerPlanRecord } from "./plans.ts";
import { slackUnfurl } from "./slack-client.ts";

const c = schema.integrationConnections;

/**
 * A Slack connection as the events endpoint reads it: one primary-key read. `plan` is the owner's
 * plan row joined into that read when the regional database is the global one (null without a
 * row), and absent with a separate regional database, where it is read only when needed.
 */
export type SlackEventConnection = Pick<
  ConnectionRow,
  "id" | "ownerId" | "service" | "keyId" | "credentialBox" | "attention" | "revision" | "externalId"
> & { plan?: OwnerPlanRecord | null };

/**
 * A key no signing secret is: a missing or pending connection costs the same HMAC as any. Made on
 * first use, never at module load: workerd refuses random values in global scope, and a Worker
 * that did it would not start.
 */
let dummySigningKey: Uint8Array<ArrayBuffer> | undefined;
function dummyKey(): Uint8Array<ArrayBuffer> {
  dummySigningKey ??= crypto.getRandomValues(new Uint8Array(32));
  return dummySigningKey;
}

const encoder = new TextEncoder();

/**
 * Verifies an inbound request's signature with the connection's own signing secret (decision
 * 0025, "Order of checks", steps 2 and 3): one D1 read by primary key, then HMAC-SHA-256 over
 * `v0:<timestamp>:<raw body>`, compared in constant time by `crypto.subtle.verify`. A missing or
 * pending connection is checked against a dummy key and refused. A connection whose credential no
 * key opens is refused and, only when it has no attention yet, marked `key_unavailable`: the one
 * write an unverified request can cause, at most once per connection. With one database the
 * owner's plan comes with the row (`bothSides`), so a preview needs no read for it.
 */
export async function verifySlackRequest(
  db: RegionalDb,
  input: {
    connectionId: string;
    timestamp: string;
    signature: Uint8Array<ArrayBuffer>;
    body: Uint8Array;
    keys: readonly IntegrationKey[];
    now: number;
  },
): Promise<SlackEventConnection | null> {
  const both = bothSides(db);
  const p = schema.ownerPlans;
  const base = (both ?? db)
    .select({
      id: c.id,
      ownerId: c.ownerId,
      service: c.service,
      keyId: c.keyId,
      credentialBox: c.credentialBox,
      attention: c.attention,
      revision: c.revision,
      externalId: c.externalId,
      ...(both
        ? {
            joinedPlan: {
              plan: p.plan,
              seats: p.seats,
              validUntil: p.validUntil,
              overrides: p.overrides,
              grace: p.grace,
            },
          }
        : {}),
    })
    .from(c)
    .$dynamic();
  const [found] = await (both ? base.leftJoin(p, eq(p.ownerId, c.ownerId)) : base)
    .where(and(eq(c.id, input.connectionId), eq(c.service, "slack")))
    .limit(1);
  let row: SlackEventConnection | undefined;
  if (found) {
    const { joinedPlan, ...rest } = found as typeof found & { joinedPlan?: OwnerPlanRecord | null };
    row = both ? { ...rest, plan: joinedPlan?.plan == null ? null : joinedPlan } : rest;
  }
  const usable = row !== undefined && row.attention !== "pending" ? row : null;
  const opened = usable
    ? await openCredential(input.keys, usable.keyId, usable.id, usable.credentialBox)
    : null;
  const secret = opened === null ? null : (openSlackCredential(opened)?.signingSecret ?? null);
  const key = await crypto.subtle.importKey(
    "raw",
    secret === null ? dummyKey() : encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    input.signature,
    slackBaseString(input.timestamp, input.body),
  );
  if (usable && secret === null) {
    if (usable.attention === null) {
      await markAttention(db, usable, "key_unavailable", { type: "system" }, input.now);
    }
    return null;
  }
  return usable && valid ? usable : null;
}

/** What the endpoint did with a verified event, for its one log line. */
export type SlackEventOutcome =
  | "ignored"
  | "team_mismatch"
  | "uninstalled"
  | "nothing_to_unfurl"
  | "unfurled"
  | "slack_error"
  | "rate_limited"
  | "credential_rejected"
  | "timeout";

export interface SlackEventResult {
  outcome: SlackEventOutcome;
  /** Links worth looking up: they name an artifact in one of the two accepted shapes. */
  candidates: number;
  /** Links sent to Slack with a preview. */
  unfurled: number;
}

/** A `link_shared` event's part a preview uses, as `parseSlackEnvelope` kept it. */
export interface SlackSharedLinks {
  links: readonly string[];
  unfurlId: string | null;
  source: SlackUnfurlSource | null;
}

/** What previews need besides the database: the connection's region, the hosts, keys and Slack. */
export interface SlackPreviewDeps {
  /**
   * `SLACK_ENABLED` with the integrations switch, as the request's handler read it. The endpoint
   * does not exist while it is off, so the app always passes true; the field is for other callers
   * and tests.
   */
  enabled: boolean;
  region: Region;
  domains: SlackLinkDomains;
  keys: readonly IntegrationKey[];
  fetch: IntegrationFetch;
  timeoutMs?: number | undefined;
  preview?: SlackPreviewOptions | undefined;
}

const result = (outcome: SlackEventOutcome, candidates = 0, unfurled = 0): SlackEventResult => ({
  outcome,
  candidates,
  unfurled,
});

/**
 * Acts on a verified `event_callback` after the answer (decision 0025, "After the answer"): the
 * envelope must come from the connection's Slack workspace; `app_uninstalled` and
 * `tokens_revoked` mark the connection `app_uninstalled` once, with one `integration.failing`;
 * `link_shared` is previewed (`previewSlackLinks`) when `preview` is given.
 */
export async function applySlackEvent(
  db: RegionalDb,
  input: {
    connection: SlackEventConnection;
    teamMatches: boolean;
    eventType: string | null;
    now: number;
    shared?: SlackSharedLinks | undefined;
    preview?: SlackPreviewDeps | undefined;
  },
): Promise<SlackEventResult> {
  if (!input.teamMatches) return result("team_mismatch");
  if (input.eventType === "link_shared" && input.shared && input.preview) {
    return previewSlackLinks(db, {
      connection: input.connection,
      shared: input.shared,
      deps: input.preview,
      now: input.now,
    });
  }
  if (input.eventType !== "app_uninstalled" && input.eventType !== "tokens_revoked") {
    return result("ignored");
  }
  // Already marked (by an earlier event, a refused token or a lost key): nothing to write.
  if (input.connection.attention !== null) return result("ignored");
  await markAttention(db, input.connection, "app_uninstalled", { type: "system" }, input.now);
  return result("uninstalled");
}

/**
 * Previews the links of one `link_shared` event (decision 0025, "The preview"): only links in the
 * two accepted shapes, only artifacts of the connection's own owner that anyone may open at that
 * moment (`openToAnyone`, the anonymous viewer's rule), only while the switch is on, the
 * connection needs no attention and the owner's plan includes integrations. Every link that does
 * not qualify, whatever the reason, ends the same way: no call to Slack. At most one
 * `chat.unfurl`, never retried; a token Slack refuses marks the connection `credential_rejected`
 * once.
 */
export async function previewSlackLinks(
  db: RegionalDb,
  input: {
    connection: SlackEventConnection;
    shared: SlackSharedLinks;
    deps: SlackPreviewDeps;
    now: number;
  },
): Promise<SlackEventResult> {
  const { connection, shared, deps } = input;
  const links = slackPreviewLinks(shared.links, deps.domains);
  if (links.length === 0) return result("nothing_to_unfurl");
  const candidates = links.length;
  if (!deps.enabled || connection.attention !== null) return result("ignored", candidates);
  if (shared.unfurlId === null || shared.source === null) {
    return result("nothing_to_unfurl", candidates);
  }
  const plan =
    connection.plan !== undefined
      ? connection.plan
      : await ownerPlanRecord(db.global, connection.ownerId);
  if (!requireFeature(entitlements(plan, input.now), INTEGRATION_FEATURE).ok) {
    return result("ignored", candidates);
  }
  const a = schema.artifacts;
  const rows = await db
    .select({
      id: a.id,
      name: a.name,
      type: a.type,
      state: a.state,
      accessMode: a.accessMode,
      expiresAt: a.expiresAt,
      archivedAt: a.archivedAt,
    })
    .from(a)
    .where(
      and(
        inArray(
          a.id,
          links.map((link) => link.artifactId),
        ),
        eq(a.ownerId, connection.ownerId),
      ),
    );
  const now = new Date(input.now);
  const visible = new Map<string, { name: string; type: ArtifactType }>();
  for (const row of rows) {
    const open = openToAnyone(
      {
        accessMode: row.accessMode,
        state: row.state,
        expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt),
        archivedAt: row.archivedAt === null ? null : new Date(row.archivedAt),
      },
      now,
    );
    if (open) visible.set(row.id, { name: row.name, type: row.type });
  }
  const previews = links.flatMap((link) => {
    const artifact = visible.get(link.artifactId);
    return artifact ? [{ url: link.url, ...artifact }] : [];
  });
  if (previews.length === 0) return result("nothing_to_unfurl", candidates);
  const opened = await openCredential(
    deps.keys,
    connection.keyId,
    connection.id,
    connection.credentialBox,
  );
  const token = opened === null ? null : (openSlackCredential(opened)?.botToken ?? null);
  // Verified with this very credential a moment ago: only a key rotated meanwhile gets here.
  if (token === null) return result("slack_error", candidates);
  const body = slackUnfurlBody(
    { unfurlId: shared.unfurlId, source: shared.source },
    previews,
    deps.region,
    deps.preview,
  );
  const answer = await slackUnfurl(token, body, { fetch: deps.fetch, timeoutMs: deps.timeoutMs });
  switch (answer.kind) {
    case "ok":
      return result("unfurled", candidates, previews.length);
    case "rejected":
      await markAttention(db, connection, "credential_rejected", { type: "system" }, input.now);
      return result("credential_rejected", candidates);
    case "rate_limited":
      return result("rate_limited", candidates);
    case "timeout":
      return result("timeout", candidates);
    default:
      return result("slack_error", candidates);
  }
}
