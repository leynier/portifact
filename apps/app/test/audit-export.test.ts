// GET /api/v1/audit/export (premium plan E3): a streamed CSV or JSON Lines download of the
// owner's audit log, in bounded parts named by a cursor header, for its admins on Enterprise;
// rate limited per owner and person; refused to service tokens. Rows are inserted as the
// services would write them.
import { env } from "cloudflare:workers";
import {
  AUDIT_EXPORT,
  AUDIT_EXPORT_CURSOR_HEADER,
  type AuditEventView,
  planRequiredMessage,
} from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { auditCsvHeader, auditCsvRow } from "@portifact/domain";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "./harness.ts";
import { api, apiToken } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-02T09:00:00Z");
const SCOPES = "artifacts:read offline_access";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const db = () => regionsFromEnv(env).get("default").db;

interface Client {
  userId: string;
  call: (path: string, init?: RequestInit) => Promise<Response>;
}

async function client(scopes = SCOPES): Promise<Client> {
  const h = createHarness();
  const token = await apiToken(h, `export-${crypto.randomUUID().slice(0, 8)}@example.test`, scopes);
  const call = (path: string, init?: RequestInit) => api(h, token, path, init);
  const { userId } = await (await call("/api/v1/me")).json<{ userId: string }>();
  return { userId, call };
}

async function onPlan(ownerId: string, plan: "team" | "enterprise") {
  await db()
    .insert(schema.ownerPlans)
    .values({ ownerId, plan, seats: 5, grantedBy: "test", updatedAt: NOW })
    .onConflictDoUpdate({ target: schema.ownerPlans.ownerId, set: { plan } });
}

/** `count` events of one kind in one statement, a second apart, newest `NOW - offset`. */
async function many(ownerId: string, count: number, kind: string, prefix: string, offset = 1000) {
  await db().run(
    sql`insert into audit_events (id, owner_id, at, kind, actor_type, actor_id, target_id, artifact_id, detail)
      with recursive n(i) as (select 0 union all select i + 1 from n where i + 1 < ${count})
      select ${prefix} || printf('%06d', i), ${ownerId}, ${NOW - offset} - i * 1000, ${kind}, 'user', ${ownerId}, ${ownerId}, null, '{}' from n`,
  );
}

async function exportAll(who: Client, query: string) {
  const parts: { status: number; headers: Headers; text: string }[] = [];
  let cursor: string | null = null;
  do {
    const response = await who.call(
      `/api/v1/audit/export?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    parts.push({ status: response.status, headers: response.headers, text: await response.text() });
    cursor = response.headers.get(AUDIT_EXPORT_CURSOR_HEADER);
  } while (cursor !== null && parts.length < 20);
  return parts;
}

describe("the export route", () => {
  it("streams a download with a fixed name, no caching and the reader's bytes", async () => {
    const owner = await client();
    await onPlan(owner.userId, "enterprise");
    await many(owner.userId, 3, "artifact.renewed", "ae_s");
    const csv = await owner.call("/api/v1/audit/export?format=csv");
    expect(csv.status).toBe(200);
    expect(csv.body).toBeInstanceOf(ReadableStream);
    expect(Object.fromEntries(csv.headers)).toMatchObject({
      "content-type": "text/csv; charset=utf-8; header=present",
      "content-disposition": 'attachment; filename="portifact-audit.csv"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    expect(csv.headers.get(AUDIT_EXPORT_CURSOR_HEADER)).toBeNull();
    const text = await csv.text();
    const page = await (await owner.call("/api/v1/audit?limit=100")).json<{
      events: AuditEventView[];
    }>();
    // The read lists the export's own event (recorded at NOW); the export ended just before it.
    const before = page.events.filter((event) => event.kind !== "audit.exported");
    expect(page.events.length - before.length).toBe(1);
    expect(text).toBe(auditCsvHeader() + before.map(auditCsvRow).join(""));
    // The same filters give the same bytes again.
    expect(await (await owner.call("/api/v1/audit/export?format=csv")).text()).toBe(text);

    const jsonl = await owner.call("/api/v1/audit/export?format=jsonl&kind=artifact.renewed");
    expect(jsonl.headers.get("content-type")).toBe("application/jsonl; charset=utf-8");
    expect(jsonl.headers.get("content-disposition")).toBe(
      'attachment; filename="portifact-audit.jsonl"',
    );
    const lines = (await jsonl.text()).trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual(before);
    expect(JSON.stringify(lines)).not.toContain("@example.test");
  });

  it("splits a large export into bounded parts that join without loss or repeat", async () => {
    const owner = await client();
    await onPlan(owner.userId, "enterprise");
    const regional = AUDIT_EXPORT.rowsPerDatabase + 250;
    await many(owner.userId, regional, "artifact.renewed", "ae_r");
    // Global events at the same moments as some regional ones, so ties cross the databases.
    await many(owner.userId, 300, "plan.removed", "ae_g");
    const parts = await exportAll(owner, "format=jsonl");
    expect(parts.map((part) => part.status)).toEqual(parts.map(() => 200));
    expect(parts.length).toBe(2);
    const ids = parts.flatMap((part) =>
      part.text
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as AuditEventView).id),
    );
    expect(ids).toHaveLength(regional + 300);
    expect(new Set(ids).size).toBe(ids.length);
    // One part never holds more than the bound from each database.
    const first = parts[0]?.text.split("\n").filter(Boolean) ?? [];
    expect(first.length).toBeLessThanOrEqual(2 * AUDIT_EXPORT.rowsPerDatabase);
    expect(first.filter((line) => line.includes('"artifact.renewed"'))).toHaveLength(
      AUDIT_EXPORT.rowsPerDatabase,
    );
    // Only the first CSV part has the header.
    const csv = await exportAll(owner, "format=csv");
    expect(csv[0]?.text.startsWith(auditCsvHeader())).toBe(true);
    expect(csv[1]?.text.startsWith("ae_")).toBe(true);
  });

  it("validates the format, filters and cursor, and needs artifacts:read", async () => {
    const owner = await client();
    await onPlan(owner.userId, "enterprise");
    for (const query of [
      "",
      "format=pdf",
      "format=csv&kind=member.vanished",
      "format=csv&from=yesterday",
      "format=csv&cursor=not-a-cursor",
    ]) {
      const response = await owner.call(`/api/v1/audit/export?${query}`);
      expect(response.status, query).toBe(400);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe("invalid_input");
    }
    const writer = await client("artifacts:write");
    expect((await writer.call("/api/v1/audit/export?format=csv")).status).toBe(403);
  });

  it("answers plan_required on Team, and rate limits starting exports", async () => {
    const team = await client();
    await onPlan(team.userId, "team");
    const refused = await team.call("/api/v1/audit/export?format=csv");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: { code: "plan_required", message: planRequiredMessage("auditExport") },
    });

    const owner = await client();
    await onPlan(owner.userId, "enterprise");
    for (let i = 0; i < AUDIT_EXPORT.perActor.max; i += 1) {
      const response = await owner.call("/api/v1/audit/export?format=jsonl");
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }
    const limited = await owner.call("/api/v1/audit/export?format=jsonl");
    expect(limited.status).toBe(429);
    expect((await limited.json<{ error: { code: string } }>()).error.code).toBe("rate_limited");
  });

  it("refuses a workspace's service token, which never reads the audit log", async () => {
    const admin = await client();
    const workspaceId = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    await db()
      .insert(schema.workspaces)
      .values({
        id: workspaceId,
        slug: workspaceId.slice(3, 23),
        name: "Team",
        createdBy: admin.userId,
        updatedAt: NOW,
      });
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId, userId: admin.userId, role: "admin", updatedAt: NOW });
    await onPlan(workspaceId, "enterprise");
    const secret = `pfst_${"A".repeat(43)}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    await db()
      .insert(schema.serviceTokens)
      .values({
        id: `st_${crypto.randomUUID().replaceAll("-", "")}`,
        workspaceId,
        label: "CI",
        role: "editor",
        scopes: "artifacts:read",
        tokenHash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
        createdBy: admin.userId,
        createdAt: NOW,
        expiresAt: NOW + 86_400_000,
      });
    const h = createHarness();
    for (const path of ["/api/v1/audit/export?format=csv", "/api/v1/audit"]) {
      const response = await h.request(path, { headers: { authorization: `Bearer ${secret}` } });
      expect(response.status, path).toBe(403);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe("forbidden");
    }
    // The admin, through the same workspace, may export.
    const slug = workspaceId.slice(3, 23);
    expect((await admin.call(`/api/v1/audit/export?format=csv&workspace=${slug}`)).status).toBe(
      200,
    );
  });
});
