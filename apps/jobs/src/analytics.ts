// Collector of Portifact's usage from Cloudflare's GraphQL Analytics API, for the budget projection
// (plan section 12), the data Worker's Durable Objects included (decision 0026, delivery 8). It is active when CF_ANALYTICS_TOKEN and CF_ACCOUNT_ID are configured (they
// are in production); the token needs only "Account Analytics: Read" (docs/operations.md). The
// account also hosts other projects, so every dataset is filtered to Portifact's bucket, Workers
// and databases. Without the settings the budget uses what D1 already knows. `fetch` is injected
// so tests never reach the network.

import type { PlatformMetrics } from "@portifact/domain";
import { CodedError, errorLabel, logEvent } from "@portifact/domain";

export const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/** Counters and the storage gauge the analytics measured; fields it could not read are absent. */
export type AnalyticsMetrics = Partial<PlatformMetrics>;

export interface AnalyticsCollector {
  collect(range: { start: number; end: number }): Promise<AnalyticsMetrics>;
}

export interface AnalyticsEnv {
  CF_ANALYTICS_TOKEN?: string | undefined;
  CF_ACCOUNT_ID?: string | undefined;
}

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/** Portifact's resources on the account, as named in the wrangler configurations. */
export const PORTIFACT_RESOURCES = {
  /**
   * One bucket per region, by the name Cloudflare's analytics give it: the default one, and the
   * EU's `portifact-artifacts-eu`, which the R2 datasets report with its jurisdiction as a prefix
   * (`eu_`). Checked on 2026-11-11 against real operations (docs/releasing.md, "EU region").
   */
  buckets: ["portifact-artifacts", "eu_portifact-artifacts-eu"],
  /**
   * The Workers. `portifact-data` (decision 0026) exports the documents objects; their own
   * requests, duration, rows and storage are Durable Object metrics, read for `dataScripts`.
   */
  scripts: ["portifact-app", "portifact-content", "portifact-jobs", "portifact-data"],
  /**
   * The Workers whose Durable Objects are artifact data's: their namespaces (one per
   * jurisdiction) are found from their invocations, so no namespace ID is configured here.
   */
  dataScripts: ["portifact-data"],
  /**
   * Each region's control database and access database (`portifact-access`, the access log and
   * the analytics view counters, decision 0007): rows read and written in all of them are billed
   * together. The default region's two first, then the EU's.
   */
  databaseIds: [
    "6cf93803-aa3c-4859-9f58-e36e2fd784e3",
    "b5285aa9-aa8d-4c2c-9828-22e31c1aec9e",
    "fb06a466-a5c3-4fda-a1dc-af6a4e12c9a4",
    "5a29e108-935d-4e21-9429-a6bcde78659b",
  ],
} as const;

/**
 * R2 operations billed as class A (writes and lists). Deletes and aborted uploads are free; every
 * other operation is billed as class B.
 * https://developers.cloudflare.com/r2/pricing/#class-a-operations
 */
const R2_CLASS_A = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "LifecycleStorageTierTransition",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
]);
const R2_FREE = new Set(["DeleteObject", "DeleteBucket", "AbortMultipartUpload"]);

/** The alias of a bucket's storage sample in the query: one field per bucket, by position. */
const storageAlias = (index: number) => `storage${index}`;

/**
 * The latest storage sample of each bucket, as one aliased field per bucket: a single field over
 * both would need a row limit, and a quiet bucket's last sample could fall outside it. The names
 * are the constants above, never input.
 */
const STORAGE_FIELDS = PORTIFACT_RESOURCES.buckets
  .map(
    (bucket, index) =>
      `${storageAlias(index)}: r2StorageAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_lt: $end, bucketName: ${JSON.stringify(bucket)} }, orderBy: [datetime_DESC]) {
        max { payloadSize metadataSize }
        dimensions { datetime }
      }`,
  )
  .join("\n      ");

export const BUDGET_QUERY = `query PortifactBudget($accountTag: string!, $start: Time!, $end: Time!, $startDate: Date!, $endDate: Date!, $buckets: [string!]!, $scripts: [string!]!, $databaseIds: [string!]!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $start, datetime_lt: $end, bucketName_in: $buckets }) {
        sum { requests }
        dimensions { actionType }
      }
      ${STORAGE_FIELDS}
      workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end, scriptName_in: $scripts }) {
        sum { requests }
      }
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $startDate, date_leq: $endDate, databaseId_in: $databaseIds }) {
        sum { rowsRead rowsWritten }
      }
    }
  }
}`;

/**
 * The documents objects' requests per namespace: the namespaces the data scripts' objects ran in
 * this cycle, which the usage query then reads. A namespace with no invocation in the cycle ran no
 * active time and wrote no row.
 */
export const DATA_REQUESTS_QUERY = `query PortifactDataRequests($accountTag: string!, $start: Time!, $end: Time!, $dataScripts: [string!]!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end, scriptName_in: $dataScripts }) {
        sum { requests }
        dimensions { namespaceId }
      }
    }
  }
}`;

/** The documents objects' active time (microseconds), incoming WebSocket messages and SQLite rows. */
export const DATA_USAGE_QUERY = `query PortifactDataUsage($accountTag: string!, $start: Time!, $end: Time!, $namespaceIds: [string!]!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsPeriodicGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end, namespaceId_in: $namespaceIds }) {
        sum { activeTime inboundWebsocketMsgCount rowsRead rowsWritten }
      }
    }
  }
}`;

/** The latest storage sample of each namespace, newest first. */
export const DATA_STORAGE_QUERY = `query PortifactDataStorage($accountTag: string!, $start: Time!, $end: Time!, $namespaceIds: [string!]!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsStorageGroups(limit: 1000, filter: { datetime_geq: $start, datetime_lt: $end, namespaceId_in: $namespaceIds }, orderBy: [datetime_DESC]) {
        max { storedBytes }
        dimensions { namespaceId }
      }
    }
  }
}`;

/** Billed duration counts every active object at 128 MB (Durable Objects pricing). */
const OBJECT_GB = 0.128;
/** Incoming WebSocket messages are billed as requests at 20 to 1. */
const WEBSOCKET_MESSAGES_PER_REQUEST = 20;

interface DataRequestsAccount {
  durableObjectsInvocationsAdaptiveGroups?: {
    sum?: { requests?: number };
    dimensions?: { namespaceId?: string };
  }[];
}

interface DataUsageAccount {
  durableObjectsPeriodicGroups?: {
    sum?: {
      activeTime?: number;
      inboundWebsocketMsgCount?: number;
      rowsRead?: number;
      rowsWritten?: number;
    };
  }[];
  durableObjectsStorageGroups?: {
    max?: { storedBytes?: number };
    dimensions?: { namespaceId?: string };
  }[];
}

/** The data scripts' invocations and the namespaces they ran in; throws when the account is not visible. */
export function parseDataRequests(data: { viewer?: { accounts?: DataRequestsAccount[] } }): {
  invocations: number;
  namespaceIds: string[];
} {
  const account = data.viewer?.accounts?.[0];
  if (!account) throw new CodedError("ANALYTICS_ACCOUNT_NOT_VISIBLE");
  const rows = account.durableObjectsInvocationsAdaptiveGroups ?? [];
  const namespaceIds = new Set<string>();
  for (const row of rows) {
    const id = row.dimensions?.namespaceId;
    if (id) namespaceIds.add(id);
  }
  return {
    invocations: total(rows, (row) => row.sum?.requests) ?? 0,
    namespaceIds: [...namespaceIds].sort(),
  };
}

type DataAnswer = { viewer?: { accounts?: DataUsageAccount[] } };

/**
 * The documents objects' metrics from their invocations and usage. Billable requests are the
 * invocations (alarms included) plus incoming WebSocket messages at 20 to 1; duration is active
 * seconds at 128 MB. Stored bytes add each namespace's latest sample and stay unmeasured without
 * one; a dataset missing from the answer leaves its metrics unmeasured.
 */
export function parseDataUsage(invocations: number, data: DataAnswer | null): AnalyticsMetrics {
  if (data === null) {
    // No namespace ran this cycle: nothing was active and no row was read or written.
    return {
      dataRequests: invocations,
      dataGbSeconds: 0,
      dataRowsRead: 0,
      dataRowsWritten: 0,
    };
  }
  const account = data.viewer?.accounts?.[0];
  if (!account) throw new CodedError("ANALYTICS_ACCOUNT_NOT_VISIBLE");
  const metrics: AnalyticsMetrics = {};
  const periodic = account.durableObjectsPeriodicGroups;
  if (periodic) {
    const messages = total(periodic, (row) => row.sum?.inboundWebsocketMsgCount) ?? 0;
    const activeMicros = total(periodic, (row) => row.sum?.activeTime) ?? 0;
    metrics.dataRequests = invocations + messages / WEBSOCKET_MESSAGES_PER_REQUEST;
    metrics.dataGbSeconds = (activeMicros / 1_000_000) * OBJECT_GB;
    metrics.dataRowsRead = total(periodic, (row) => row.sum?.rowsRead) ?? 0;
    metrics.dataRowsWritten = total(periodic, (row) => row.sum?.rowsWritten) ?? 0;
  }
  const storage = account.durableObjectsStorageGroups;
  if (storage) {
    const latest = new Map<string, number>();
    for (const row of storage) {
      const id = row.dimensions?.namespaceId;
      if (id && !latest.has(id)) latest.set(id, row.max?.storedBytes ?? 0);
    }
    if (latest.size > 0) metrics.dataStoredBytes = [...latest.values()].reduce((a, b) => a + b, 0);
  }
  return metrics;
}

type StorageSample = { max?: { payloadSize?: number; metadataSize?: number } };

interface BudgetAccount {
  r2OperationsAdaptiveGroups?: {
    sum?: { requests?: number };
    dimensions?: { actionType?: string };
  }[];
  workersInvocationsAdaptive?: { sum?: { requests?: number } }[];
  d1AnalyticsAdaptiveGroups?: { sum?: { rowsRead?: number; rowsWritten?: number } }[];
  /** The storage samples, one aliased field per bucket (`storageAlias`). */
  [alias: `storage${number}`]: StorageSample[] | undefined;
}

interface BudgetQueryData {
  viewer?: { accounts?: BudgetAccount[] };
}

/**
 * The bytes stored in every bucket, from each one's latest sample. A bucket without a sample (an
 * empty one) adds nothing; with no sample at all the metric stays unmeasured.
 */
function storedBytes(account: BudgetAccount): number | undefined {
  const samples = PORTIFACT_RESOURCES.buckets
    .map((_, index) => account[storageAlias(index) as `storage${number}`]?.[0]?.max)
    .filter((sample) => sample !== undefined);
  if (samples.length === 0) return undefined;
  return samples.reduce(
    (sum, sample) => sum + (sample.payloadSize ?? 0) + (sample.metadataSize ?? 0),
    0,
  );
}

const total = <T>(rows: T[] | undefined, pick: (row: T) => number | undefined) =>
  rows === undefined ? undefined : rows.reduce((sum, row) => sum + (pick(row) ?? 0), 0);

/** Turns the GraphQL answer into metrics; a dataset missing from the answer stays unmeasured. */
export function parseBudgetData(data: BudgetQueryData): AnalyticsMetrics {
  const account = data.viewer?.accounts?.[0];
  if (!account) throw new CodedError("ANALYTICS_ACCOUNT_NOT_VISIBLE");
  const metrics: AnalyticsMetrics = {};
  const operations = account.r2OperationsAdaptiveGroups;
  if (operations) {
    let classA = 0;
    let classB = 0;
    for (const row of operations) {
      const action = row.dimensions?.actionType ?? "";
      const requests = row.sum?.requests ?? 0;
      if (R2_CLASS_A.has(action)) classA += requests;
      else if (!R2_FREE.has(action)) classB += requests;
    }
    metrics.r2ClassA = classA;
    metrics.r2ClassB = classB;
  }
  const stored = storedBytes(account);
  if (stored !== undefined) metrics.storedBytes = stored;
  const requests = total(account.workersInvocationsAdaptive, (row) => row.sum?.requests);
  if (requests !== undefined) metrics.workerRequests = requests;
  const d1 = account.d1AnalyticsAdaptiveGroups;
  if (d1) {
    metrics.d1RowsRead = total(d1, (row) => row.sum?.rowsRead) as number;
    metrics.d1RowsWritten = total(d1, (row) => row.sum?.rowsWritten) as number;
  }
  return metrics;
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** One GraphQL request; errors carry no token or response body, only the status or a count. */
async function graphql<T>(
  config: { token: string },
  fetcher: Fetcher,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetcher(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new CodedError("ANALYTICS_HTTP", response.status);
  }
  const body = (await response.json()) as { data?: T | null; errors?: unknown[] };
  if (body.errors && body.errors.length > 0) {
    throw new CodedError("ANALYTICS_GRAPHQL_ERRORS", body.errors.length);
  }
  return (body.data ?? {}) as T;
}

/**
 * The collector for one account. The documents objects are read in their own requests after the
 * platform's: a failure there leaves only the data metrics unmeasured (the budget carries their
 * last values forward) and logs `budget_data_analytics_failed`, so it never loses the rest.
 */
export function cloudflareAnalytics(
  config: { token: string; accountId: string },
  fetcher: Fetcher,
): AnalyticsCollector {
  return {
    async collect({ start, end }) {
      const range = {
        accountTag: config.accountId,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
      };
      const platform = parseBudgetData(
        await graphql<BudgetQueryData>(config, fetcher, BUDGET_QUERY, {
          ...range,
          startDate: isoDate(start),
          endDate: isoDate(end - 1),
          buckets: PORTIFACT_RESOURCES.buckets,
          scripts: PORTIFACT_RESOURCES.scripts,
          databaseIds: PORTIFACT_RESOURCES.databaseIds,
        }),
      );
      try {
        const requests = parseDataRequests(
          await graphql(config, fetcher, DATA_REQUESTS_QUERY, {
            ...range,
            dataScripts: PORTIFACT_RESOURCES.dataScripts,
          }),
        );
        if (requests.namespaceIds.length === 0) {
          return { ...platform, ...parseDataUsage(requests.invocations, null) };
        }
        const namespaces = { ...range, namespaceIds: requests.namespaceIds };
        const usage = parseDataUsage(
          requests.invocations,
          await graphql<DataAnswer>(config, fetcher, DATA_USAGE_QUERY, namespaces),
        );
        // Storage on its own: a failure there leaves only the stored bytes unmeasured.
        try {
          const storage = parseDataUsage(
            requests.invocations,
            await graphql<DataAnswer>(config, fetcher, DATA_STORAGE_QUERY, namespaces),
          );
          if (storage.dataStoredBytes !== undefined)
            usage.dataStoredBytes = storage.dataStoredBytes;
        } catch (error) {
          logEvent("error", "budget_data_storage_failed", { error: errorLabel(error) });
        }
        return { ...platform, ...usage };
      } catch (error) {
        logEvent("error", "budget_data_analytics_failed", { error: errorLabel(error) });
        return platform;
      }
    },
  };
}

/** The collector when both settings are present, otherwise null (analytics off). */
export function analyticsFromEnv(env: AnalyticsEnv, fetcher: Fetcher): AnalyticsCollector | null {
  const token = env.CF_ANALYTICS_TOKEN?.trim();
  const accountId = env.CF_ACCOUNT_ID?.trim();
  return token && accountId ? cloudflareAnalytics({ token, accountId }, fetcher) : null;
}
