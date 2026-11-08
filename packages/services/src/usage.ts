// Account usage (plan section 6, "Uso"): the counters the publish admission reads, the events of
// the 24-hour windows and the blocks the domain derives from them. Read-only; every query is
// keyed by the account from the session or token.
import { LIMITS, TRAFFIC_LIMITS } from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import {
  type Block,
  nextMonthStart,
  protectionBlock,
  publicAccessFrom,
  trafficCycle,
  USAGE_WINDOW_MS,
  usageBlocks,
  type WindowEvent,
  windowTotal,
} from "@portifact/domain";
import { and, asc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { platformProtection } from "./budget.ts";
import { getTraffic } from "./traffic.ts";

export interface Meter {
  used: number;
  limit: number;
}

export interface AccountUsageReport {
  activeArtifacts: Meter;
  storage: Meter & { reserved: number };
  publishesLast24h: Meter;
  newFilesLast24h: Meter;
  newBytesLast24h: Meter;
  newObjectsThisMonth: Meter & { resetsAt: number };
  openUploads: Meter;
  trafficThisMonth: { requests: Meter; bytes: Meter; resetsAt: number };
  versionLimits: { publishedBytes: number; files: number; documentBytes: number };
  publicAccessFrom: number;
  blocks: Block[];
}

type WindowKind = "publish" | "new_files" | "new_bytes";

/** Upload states that hold a slot until they are committed, aborted or expire. */
const OPEN_UPLOAD_STATES: ("uploading" | "verifying" | "ready")[] = [
  "uploading",
  "verifying",
  "ready",
];

async function windowEvents(db: Db, ownerId: string, since: number) {
  const rows = await db
    .select({
      kind: schema.usageEvents.kind,
      at: schema.usageEvents.at,
      amount: schema.usageEvents.amount,
    })
    .from(schema.usageEvents)
    .where(
      and(
        eq(schema.usageEvents.ownerId, ownerId),
        gte(schema.usageEvents.at, since),
        // Events that counted nothing (a publish with every file already stored) cannot hold
        // a window full, so they are left out.
        gt(schema.usageEvents.amount, 0),
      ),
    )
    .orderBy(asc(schema.usageEvents.at), asc(schema.usageEvents.id));
  const events: Record<WindowKind, WindowEvent[]> = { publish: [], new_files: [], new_bytes: [] };
  for (const row of rows) events[row.kind].push({ at: row.at, amount: row.amount });
  return events;
}

/** The account's quotas, current counters, 24-hour windows and what blocks it now. */
export async function getAccountUsage(
  db: Db,
  input: { ownerId: string; now: number },
): Promise<AccountUsageReport> {
  const [usage] = await db
    .select()
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, input.ownerId))
    .limit(1);
  const [user] = await db
    .select({ createdAt: schema.users.createdAt })
    .from(schema.users)
    .where(eq(schema.users.id, input.ownerId))
    .limit(1);
  const [uploads] = await db
    .select({ first: sql<number | null>`min(${schema.uploadSessions.expiresAt})` })
    .from(schema.uploadSessions)
    .where(
      and(
        eq(schema.uploadSessions.ownerId, input.ownerId),
        // An expired upload still holds its slot until the maintenance job releases it.
        inArray(schema.uploadSessions.state, OPEN_UPLOAD_STATES),
      ),
    );
  const events = await windowEvents(db, input.ownerId, input.now - USAGE_WINDOW_MS);
  const traffic = await getTraffic(db, input.ownerId, input.now);
  const capacity = protectionBlock((await platformProtection(db, input.now)).actions);

  // The monthly counter belongs to the month it was last written in, as preparePublish reads it.
  const resetsAt = nextMonthStart(input.now);
  const sameMonth = usage !== undefined && nextMonthStart(usage.monthStartedAt) === resetsAt;
  const snapshot = {
    now: input.now,
    // An account without a user row cannot sign in; treat it as new, which only hides public.
    accountCreatedAt: user ? user.createdAt.getTime() : input.now,
    activeArtifacts: usage?.activeArtifacts ?? 0,
    storedBytes: usage?.storedBytes ?? 0,
    reservedBytes: usage?.reservedBytes ?? 0,
    openUploads: usage?.openUploads ?? 0,
    firstUploadExpiry: uploads?.first == null ? null : Number(uploads.first),
    newObjectsThisMonth: sameMonth ? usage.newObjectsThisMonth : 0,
    publishes: events.publish,
    newFiles: events.new_files,
    newBytes: events.new_bytes,
    traffic,
  };

  return {
    activeArtifacts: { used: snapshot.activeArtifacts, limit: LIMITS.activeArtifacts },
    storage: {
      used: snapshot.storedBytes,
      reserved: snapshot.reservedBytes,
      limit: LIMITS.accountBytes,
    },
    publishesLast24h: { used: windowTotal(events.publish), limit: LIMITS.publishesPer24h },
    newFilesLast24h: { used: windowTotal(events.new_files), limit: LIMITS.newFilesPer24h },
    newBytesLast24h: { used: windowTotal(events.new_bytes), limit: LIMITS.newBytesPer24h },
    newObjectsThisMonth: {
      used: snapshot.newObjectsThisMonth,
      limit: LIMITS.newObjectsPerMonth,
      resetsAt,
    },
    openUploads: { used: snapshot.openUploads, limit: LIMITS.concurrentUploads },
    trafficThisMonth: {
      requests: { used: traffic.requests, limit: TRAFFIC_LIMITS.requestsPerMonth },
      bytes: { used: traffic.bytes, limit: TRAFFIC_LIMITS.bytesPerMonth },
      resetsAt: trafficCycle(input.now).resetsAt,
    },
    versionLimits: {
      publishedBytes: LIMITS.artifactBytes,
      files: LIMITS.filesPerVersion,
      documentBytes: LIMITS.documentBytes,
    },
    publicAccessFrom: publicAccessFrom(snapshot.accountCreatedAt),
    // The platform's budget protection comes first: it is why the dashboard shows its notice.
    blocks: capacity ? [capacity, ...usageBlocks(snapshot)] : usageBlocks(snapshot),
  };
}
