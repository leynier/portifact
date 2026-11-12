// Slack link previews (decision 0025, delivery 2): a verified `link_shared` event is answered with
// one `chat.unfurl` naming the public, active artifacts of the connection's own owner, and with
// nothing at all for every other link, whatever the reason. Against the real D1 schema in workerd
// (with a second region and the strict region guard) and the fake Slack. Nothing reaches Slack.
import { env } from "cloudflare:test";
import type { ArtifactType, Region } from "@portifact/contracts";
import { type RegionalDb, regionsFromEnv, schema } from "@portifact/db";
import { type Actor, personalActor } from "@portifact/domain";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { actorOn } from "../src/actors.ts";
import { integrationKeys } from "../src/integration-keys.ts";
import { createIntegrationConnection, updateIntegrationConnection } from "../src/integrations.ts";
import {
  applySlackEvent,
  type SlackEventConnection,
  type SlackPreviewDeps,
  verifySlackRequest,
} from "../src/slack-events.ts";
import { FakeSlack } from "../src/testing/fake-slack.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { DAY, db, grantPlan, NOW, value } from "./fixtures.ts";

const KEY_TEXT = "test-only integrations sealing key, long enough to use";
const TEAM = "T0ACME01";
const DOMAINS = { contentDomain: "portifact.dev", appHost: "app.portifact.com" };
const STAMP = String(Math.floor(NOW / 1000));

function artifactId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => alphabet[b % 32]).join("");
}

async function person() {
  const id = `u_${crypto.randomUUID()}`;
  await db()
    .global.insert(schema.users)
    .values({
      id,
      name: "Someone",
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date(NOW - 30 * DAY),
      updatedAt: new Date(NOW),
    });
  return id;
}

interface Artifact {
  name?: string;
  type?: ArtifactType;
  state?: "active" | "archived" | "suspended" | "purging" | "deleted";
  accessMode?: "public" | "authenticated" | "restricted" | "workspace" | "domain";
  expiresAt?: number | null;
}

async function artifact(on: RegionalDb, ownerId: string, fields: Artifact = {}) {
  const id = artifactId();
  await on.insert(schema.artifacts).values({
    id,
    ownerId,
    type: fields.type ?? "markdown",
    name: fields.name ?? "Q3 plan",
    state: fields.state ?? "active",
    annotations: "open",
    accessMode: fields.accessMode ?? "public",
    expiresAt: fields.expiresAt === undefined ? NOW + 30 * DAY : fields.expiresAt,
    archivedAt: fields.state === "archived" ? NOW - DAY : null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

/** An owner on Team with a completed Slack connection, in `region`. */
async function connected(region: Region = "default") {
  const regions = regionsFromEnv(env);
  const on = regions.get(region).db;
  const userId = await person();
  let ownerId = userId;
  let actor: Actor = personalActor(userId);
  if (region !== "default") {
    const created = value(
      await createWorkspace(regions.global, {
        slug: `prev-${crypto.randomUUID().slice(0, 8)}`,
        name: "EU",
        adminUserId: userId,
        now: NOW,
        region,
      }),
    );
    ownerId = created.id;
    const found = await actorOn(regions.global, userId, ownerId);
    if (!found.ok || !found.value) throw new Error("no role");
    actor = found.value;
  }
  await grantPlan(ownerId, "team");
  const botToken = FakeSlack.botToken();
  const signingSecret = FakeSlack.signingSecret();
  const fake = new FakeSlack().bot(botToken, "Acme", TEAM);
  const keys = await integrationKeys({ current: KEY_TEXT });
  const deps = { keys, service: { enabled: true, slack: true }, fetch: fake.fetch };
  const pending = value(
    await createIntegrationConnection(on, {
      actor,
      connection: { service: "slack", label: "Acme" },
      deps,
      now: NOW,
    }),
  );
  value(
    await updateIntegrationConnection(on, {
      actor,
      connectionId: pending.id,
      update: { botToken, signingSecret },
      deps,
      now: NOW,
    }),
  );
  fake.requests.length = 0;
  const preview: SlackPreviewDeps = {
    enabled: true,
    region,
    domains: DOMAINS,
    keys,
    fetch: fake.fetch,
  };
  /** The connection as the endpoint reads it, through a correctly signed request. */
  const read = async (): Promise<SlackEventConnection> => {
    const body = new TextEncoder().encode("{}");
    const header = await FakeSlack.signature(signingSecret, STAMP, "{}");
    const signature = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      signature[i] = Number.parseInt(header.slice(3 + i * 2, 5 + i * 2), 16);
    }
    const found = await verifySlackRequest(on, {
      connectionId: pending.id,
      timestamp: STAMP,
      signature,
      body,
      keys,
      now: NOW,
    });
    if (!found) throw new Error("not verified");
    return found;
  };
  const share = async (
    urls: readonly string[],
    options: { preview?: Partial<SlackPreviewDeps>; teamMatches?: boolean; source?: string } = {},
  ) =>
    applySlackEvent(on, {
      connection: await read(),
      teamMatches: options.teamMatches ?? true,
      eventType: "link_shared",
      now: NOW,
      shared: {
        links: urls,
        unfurlId: "C0CHANNEL1.1700000000.000100.abc",
        source: (options.source ?? "conversations_history") as "conversations_history",
      },
      preview: { ...preview, ...options.preview },
    });
  return { on, ownerId, connectionId: pending.id, fake, share, read };
}

const dev = (id: string, path = "/") => `https://${id}.portifact.dev${path}`;
const view = (id: string) => `https://app.portifact.com/view/${id}`;

describe("a link to a public artifact of the connection's owner", () => {
  it("is previewed with its name and type in one chat.unfurl, keyed by the URL as sent", async () => {
    const s = await connected();
    const site = await artifact(s.on, s.ownerId, { name: "Launch site", type: "site" });
    const doc = await artifact(s.on, s.ownerId, { name: "Q3 plan", type: "markdown" });
    const urls = [dev(site, "/a.html?x=1&y=2#top"), view(doc)];
    expect(await s.share(urls)).toEqual({ outcome: "unfurled", candidates: 2, unfurled: 2 });
    expect(s.fake.requests.map((r) => r.url)).toEqual(["https://slack.com/api/chat.unfurl"]);
    expect(s.fake.unfurls).toEqual([
      {
        unfurl_id: "C0CHANNEL1.1700000000.000100.abc",
        source: "conversations_history",
        unfurls: {
          [urls[0] as string]: {
            blocks: [
              { type: "section", text: { type: "plain_text", text: "Launch site", emoji: false } },
              {
                type: "context",
                elements: [{ type: "plain_text", text: "Website on Portifact", emoji: false }],
              },
            ],
          },
          [urls[1] as string]: {
            blocks: [
              { type: "section", text: { type: "plain_text", text: "Q3 plan", emoji: false } },
              {
                type: "context",
                elements: [
                  { type: "plain_text", text: "Markdown document on Portifact", emoji: false },
                ],
              },
            ],
          },
        },
      },
    ]);
  });

  it("previews only the public ones of a mixed message, in one call", async () => {
    const s = await connected();
    const open = await artifact(s.on, s.ownerId, { type: "text", name: "Notes" });
    const closed = await artifact(s.on, s.ownerId, { accessMode: "restricted" });
    expect(await s.share([dev(closed), dev(open), "https://app.portifact.com/s#secret"])).toEqual({
      outcome: "unfurled",
      candidates: 2,
      unfurled: 1,
    });
    const sent = s.fake.unfurls[0] as { unfurls: Record<string, unknown> };
    expect(Object.keys(sent.unfurls)).toEqual([dev(open)]);
    expect(JSON.stringify(sent)).not.toContain(closed);
  });

  it("keeps hostile names inert: escaped, cleaned, plain text without emoji", async () => {
    const s = await connected();
    const name = "<!channel> <@U123> *bold* <https://example.com|x> :smile: a\u202eb\u200bc";
    const id = await artifact(s.on, s.ownerId, { name });
    expect((await s.share([dev(id)])).outcome).toBe("unfurled");
    const raw = s.fake.requests[0]?.body ?? "";
    const sent = JSON.parse(raw) as {
      unfurls: Record<string, { blocks: { text?: { text: string; emoji: boolean } }[] }>;
    };
    const text = sent.unfurls[dev(id)]?.blocks[0]?.text;
    expect(text).toEqual({
      type: "plain_text",
      text: "&lt;!channel&gt; &lt;@U123&gt; *bold* &lt;https://example.com|x&gt; :smile: abc",
      emoji: false,
    });
    expect(raw).not.toMatch(/[<>]/);
  });

  it("names an EU workspace's artifact, or only its type when names stay home", async () => {
    const s = await connected("eu");
    const id = await artifact(s.on, s.ownerId, { name: "EU plan" });
    expect((await s.share([dev(id)])).outcome).toBe("unfurled");
    expect(JSON.stringify(s.fake.unfurls[0])).toContain("EU plan");
    expect(
      (await s.share([dev(id)], { preview: { preview: { namesOutsideDefault: false } } })).outcome,
    ).toBe("unfurled");
    const second = JSON.stringify(s.fake.unfurls[1]);
    expect(second).not.toContain("EU plan");
    expect(second).toContain("An artifact on Portifact");
  });
});

describe("every other link", () => {
  it("makes no call to Slack, the same way for each reason", async () => {
    const s = await connected();
    const other = await person();
    const cases: [string, string[]][] = [
      ["unknown ID", [dev(artifactId())]],
      ["private", [dev(await artifact(s.on, s.ownerId, { accessMode: "restricted" }))]],
      ["signed in only", [dev(await artifact(s.on, s.ownerId, { accessMode: "authenticated" }))]],
      ["another owner's public artifact", [dev(await artifact(s.on, other))]],
      ["archived", [dev(await artifact(s.on, s.ownerId, { state: "archived" }))]],
      ["expired", [dev(await artifact(s.on, s.ownerId, { expiresAt: NOW - 1 }))]],
      ["suspended", [dev(await artifact(s.on, s.ownerId, { state: "suspended" }))]],
      ["purging", [dev(await artifact(s.on, s.ownerId, { state: "purging" }))]],
      ["deleted", [dev(await artifact(s.on, s.ownerId, { state: "deleted" }))]],
    ];
    for (const [label, urls] of cases) {
      expect(await s.share(urls), label).toEqual({
        outcome: "nothing_to_unfurl",
        candidates: 1,
        unfurled: 0,
      });
    }
    // Links that are not in the two shapes are not even looked up.
    for (const url of [
      "https://app.portifact.com/s#token",
      `https://app.portifact.com/read/${artifactId()}`,
      "https://docs.example.com/",
    ]) {
      expect(await s.share([url]), url).toEqual({
        outcome: "nothing_to_unfurl",
        candidates: 0,
        unfurled: 0,
      });
    }
    expect(s.fake.requests).toEqual([]);
  });

  it("stops previewing an artifact moved to another owner", async () => {
    const s = await connected();
    const id = await artifact(s.on, s.ownerId);
    expect((await s.share([dev(id)])).outcome).toBe("unfurled");
    await s.on
      .update(schema.artifacts)
      .set({ ownerId: await person() })
      .where(eq(schema.artifacts.id, id));
    expect((await s.share([dev(id)])).outcome).toBe("nothing_to_unfurl");
    expect(s.fake.requests).toHaveLength(1);
  });

  it("is ignored for another Slack workspace, without the plan, while off or needing attention", async () => {
    const s = await connected();
    const id = await artifact(s.on, s.ownerId);
    expect((await s.share([dev(id)], { teamMatches: false })).outcome).toBe("team_mismatch");
    expect((await s.share([dev(id)], { preview: { enabled: false } })).outcome).toBe("ignored");
    await grantPlan(s.ownerId, "pro");
    expect(await s.share([dev(id)])).toEqual({ outcome: "ignored", candidates: 1, unfurled: 0 });
    await grantPlan(s.ownerId, "team", { validUntil: NOW - 1 });
    expect((await s.share([dev(id)])).outcome).toBe("ignored");
    await grantPlan(s.ownerId, "team");
    await s.on
      .update(schema.integrationConnections)
      .set({ attention: "app_uninstalled" })
      .where(eq(schema.integrationConnections.id, s.connectionId));
    expect((await s.share([dev(id)])).outcome).toBe("ignored");
    expect(s.fake.requests).toEqual([]);
  });

  it("is ignored with the plan read from the global database too, for an EU owner", async () => {
    const s = await connected("eu");
    const id = await artifact(s.on, s.ownerId);
    expect((await s.read()).plan).toBeUndefined();
    await regionsFromEnv(env)
      .global.delete(schema.ownerPlans)
      .where(eq(schema.ownerPlans.ownerId, s.ownerId));
    expect((await s.share([dev(id)])).outcome).toBe("ignored");
    expect(s.fake.requests).toEqual([]);
  });

  it("needs the event's unfurl ID and source in their shapes", async () => {
    const s = await connected();
    const id = await artifact(s.on, s.ownerId);
    const answer = await applySlackEvent(s.on, {
      connection: await s.read(),
      teamMatches: true,
      eventType: "link_shared",
      now: NOW,
      shared: { links: [dev(id)], unfurlId: null, source: "composer" },
      preview: {
        enabled: true,
        region: "default",
        domains: DOMAINS,
        keys: await integrationKeys({ current: KEY_TEXT }),
        fetch: s.fake.fetch,
      },
    });
    expect(answer).toEqual({ outcome: "nothing_to_unfurl", candidates: 1, unfurled: 0 });
    expect(s.fake.requests).toEqual([]);
  });

  it("is ignored by a caller that offers no previews", async () => {
    const s = await connected();
    const id = await artifact(s.on, s.ownerId);
    const answer = await applySlackEvent(s.on, {
      connection: await s.read(),
      teamMatches: true,
      eventType: "link_shared",
      now: NOW,
      shared: { links: [dev(id)], unfurlId: "u", source: "composer" },
    });
    expect(answer.outcome).toBe("ignored");
  });
});

describe("Slack's answer to chat.unfurl", () => {
  it("is dropped and logged by outcome, never retried; a refused token marks the connection once", async () => {
    const s = await connected();
    const id = await artifact(s.on, s.ownerId);
    const urls = [dev(id)];
    s.fake.next(Response.json({ ok: false, error: "cannot_unfurl_url" }));
    expect((await s.share(urls)).outcome).toBe("slack_error");
    s.fake.next(new Response("busy", { status: 503 }));
    expect((await s.share(urls)).outcome).toBe("slack_error");
    s.fake.next(new Response(null, { status: 429, headers: { "retry-after": "30" } }));
    expect((await s.share(urls)).outcome).toBe("rate_limited");
    s.fake.next(Response.json({ ok: false, error: "ratelimited" }));
    expect((await s.share(urls)).outcome).toBe("rate_limited");
    s.fake.next("hang");
    expect((await s.share(urls, { preview: { timeoutMs: 20 } })).outcome).toBe("timeout");
    expect(s.fake.requests).toHaveLength(5);
    const audit = async () =>
      (
        await s.on
          .select()
          .from(schema.auditEvents)
          .where(eq(schema.auditEvents.ownerId, s.ownerId))
          .orderBy(schema.auditEvents.at, sql`rowid`)
      ).filter((e) => e.kind === "integration.failing");
    expect(await audit()).toEqual([]);
    s.fake.next(Response.json({ ok: false, error: "token_revoked" }));
    expect((await s.share(urls)).outcome).toBe("credential_rejected");
    const [row] = await s.on
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.id, s.connectionId));
    expect(row?.attention).toBe("credential_rejected");
    // Marked: later links are ignored without calling Slack.
    expect((await s.share(urls)).outcome).toBe("ignored");
    expect(s.fake.requests).toHaveLength(6);
    expect((await audit()).map((e) => e.detail)).toEqual([
      { service: "slack", reason: "credential_rejected" },
    ]);
  });

  it("is not asked when the sealed credential no longer opens with the Worker's keys", async () => {
    const s = await connected();
    const id = await artifact(s.on, s.ownerId);
    const answer = await applySlackEvent(s.on, {
      connection: await s.read(),
      teamMatches: true,
      eventType: "link_shared",
      now: NOW,
      shared: { links: [dev(id)], unfurlId: "u", source: "composer" },
      preview: {
        enabled: true,
        region: "default",
        domains: DOMAINS,
        keys: await integrationKeys({ current: "another test-only integrations key, long enough" }),
        fetch: s.fake.fetch,
      },
    });
    expect(answer.outcome).toBe("slack_error");
    expect(s.fake.requests).toEqual([]);
  });
});
