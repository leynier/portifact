// Collector of Portifact's usage from Cloudflare's GraphQL Analytics API, for the budget projection
// (plan section 12). It is active when CF_ANALYTICS_TOKEN and CF_ACCOUNT_ID are configured (they
// are in production); the token needs only "Account Analytics: Read" (docs/operations.md). The
// account also hosts other projects, so every dataset is filtered to Portifact's bucket, Workers
// and databases. Without the settings the budget uses what D1 already knows. `fetch` is injected
// so tests never reach the network.
import type { PlatformMetrics } from "@portifact/domain";

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
  bucket: "portifact-artifacts",
  scripts: ["portifact-app", "portifact-content", "portifact-jobs"],
  /**
   * The control database and the access database (`portifact-access`, the access log and the
   * analytics view counters, decision 0007): rows read and written in both are billed together.
   */
  databaseIds: ["6cf93803-aa3c-4859-9f58-e36e2fd784e3", "b5285aa9-aa8d-4c2c-9828-22e31c1aec9e"],
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

export const BUDGET_QUERY = `query PortifactBudget($accountTag: string!, $start: Time!, $end: Time!, $startDate: Date!, $endDate: Date!, $bucket: string!, $scripts: [string!]!, $databaseIds: [string!]!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $start, datetime_lt: $end, bucketName: $bucket }) {
        sum { requests }
        dimensions { actionType }
      }
      r2StorageAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_lt: $end, bucketName: $bucket }, orderBy: [datetime_DESC]) {
        max { payloadSize metadataSize }
        dimensions { datetime }
      }
      workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end, scriptName_in: $scripts }) {
        sum { requests }
      }
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $startDate, date_leq: $endDate, databaseId_in: $databaseIds }) {
        sum { rowsRead rowsWritten }
      }
    }
  }
}`;

interface BudgetQueryData {
  viewer?: {
    accounts?: {
      r2OperationsAdaptiveGroups?: {
        sum?: { requests?: number };
        dimensions?: { actionType?: string };
      }[];
      r2StorageAdaptiveGroups?: { max?: { payloadSize?: number; metadataSize?: number } }[];
      workersInvocationsAdaptive?: { sum?: { requests?: number } }[];
      d1AnalyticsAdaptiveGroups?: { sum?: { rowsRead?: number; rowsWritten?: number } }[];
    }[];
  };
}

const total = <T>(rows: T[] | undefined, pick: (row: T) => number | undefined) =>
  rows === undefined ? undefined : rows.reduce((sum, row) => sum + (pick(row) ?? 0), 0);

/** Turns the GraphQL answer into metrics; a dataset missing from the answer stays unmeasured. */
export function parseBudgetData(data: BudgetQueryData): AnalyticsMetrics {
  const account = data.viewer?.accounts?.[0];
  if (!account) throw new Error("analytics: the account is not visible to this token");
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
  const storage = account.r2StorageAdaptiveGroups?.[0]?.max;
  if (storage) metrics.storedBytes = (storage.payloadSize ?? 0) + (storage.metadataSize ?? 0);
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

/** The collector for one account. Errors carry no token or response body, only the status. */
export function cloudflareAnalytics(
  config: { token: string; accountId: string },
  fetcher: Fetcher,
): AnalyticsCollector {
  return {
    async collect({ start, end }) {
      const response = await fetcher(GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: BUDGET_QUERY,
          variables: {
            accountTag: config.accountId,
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
            startDate: isoDate(start),
            endDate: isoDate(end - 1),
            bucket: PORTIFACT_RESOURCES.bucket,
            scripts: PORTIFACT_RESOURCES.scripts,
            databaseIds: PORTIFACT_RESOURCES.databaseIds,
          },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`analytics: HTTP ${response.status}`);
      }
      const body = (await response.json()) as { data?: BudgetQueryData | null; errors?: unknown[] };
      if (body.errors && body.errors.length > 0) {
        throw new Error(`analytics: ${body.errors.length} GraphQL error(s)`);
      }
      return parseBudgetData(body.data ?? {});
    },
  };
}

/** The collector when both settings are present, otherwise null (analytics off). */
export function analyticsFromEnv(env: AnalyticsEnv, fetcher: Fetcher): AnalyticsCollector | null {
  const token = env.CF_ANALYTICS_TOKEN?.trim();
  const accountId = env.CF_ACCOUNT_ID?.trim();
  return token && accountId ? cloudflareAnalytics({ token, accountId }, fetcher) : null;
}
