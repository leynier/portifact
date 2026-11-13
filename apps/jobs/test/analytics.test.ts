import { errorLabel } from "@portifact/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyticsFromEnv,
  BUDGET_QUERY,
  cloudflareAnalytics,
  DATA_REQUESTS_QUERY,
  DATA_STORAGE_QUERY,
  DATA_USAGE_QUERY,
  type Fetcher,
  GRAPHQL_ENDPOINT,
  parseBudgetData,
  parseDataRequests,
  parseDataUsage,
} from "../src/analytics.ts";

const RANGE = { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 10, 8, 12) };
const TOKEN = "test-token-not-a-secret";

const answer = {
  viewer: {
    accounts: [
      {
        r2OperationsAdaptiveGroups: [
          { sum: { requests: 120 }, dimensions: { actionType: "PutObject" } },
          { sum: { requests: 30 }, dimensions: { actionType: "ListObjects" } },
          { sum: { requests: 900 }, dimensions: { actionType: "GetObject" } },
          { sum: { requests: 100 }, dimensions: { actionType: "HeadObject" } },
          { sum: { requests: 77 }, dimensions: { actionType: "DeleteObject" } },
          { sum: {}, dimensions: {} },
        ],
        storage0: [{ max: { payloadSize: 5_000, metadataSize: 25 } }],
        storage1: [{ max: { payloadSize: 700, metadataSize: 5 } }],
        workersInvocationsAdaptive: [{ sum: { requests: 1_000 } }, { sum: { requests: 500 } }],
        d1AnalyticsAdaptiveGroups: [
          { sum: { rowsRead: 10, rowsWritten: 2 } },
          { sum: { rowsRead: 5 } },
        ],
      },
    ],
  },
};

const dataRequests = {
  viewer: {
    accounts: [
      {
        durableObjectsInvocationsAdaptiveGroups: [
          { sum: { requests: 900 }, dimensions: { namespaceId: "ns-default" } },
          { sum: { requests: 100 }, dimensions: { namespaceId: "ns-eu" } },
          { sum: { requests: 50 }, dimensions: { namespaceId: "ns-default" } },
        ],
      },
    ],
  },
};

const dataUsage = {
  viewer: {
    accounts: [
      {
        durableObjectsPeriodicGroups: [
          {
            sum: {
              activeTime: 2_000_000,
              inboundWebsocketMsgCount: 400,
              rowsRead: 1_000,
              rowsWritten: 300,
            },
          },
          { sum: { activeTime: 500_000, rowsRead: 20 } },
        ],
      },
    ],
  },
};

const dataStorage = {
  viewer: {
    accounts: [
      {
        durableObjectsStorageGroups: [
          { max: { storedBytes: 7_000 }, dimensions: { namespaceId: "ns-eu" } },
          { max: { storedBytes: 5_000 }, dimensions: { namespaceId: "ns-default" } },
          { max: { storedBytes: 1 }, dimensions: { namespaceId: "ns-eu" } },
        ],
      },
    ],
  },
};

/** A fake fetch that answers each query with its own body, or a status it is told to fail with. */
function routedFetch(answers: Map<string, unknown>, failing: Map<string, number> = new Map()) {
  const queries: string[] = [];
  const fetcher: Fetcher = async (_url, init) => {
    const { query } = JSON.parse(init.body as string) as { query: string };
    queries.push(query);
    const status = failing.get(query);
    if (status !== undefined) return new Response("no", { status });
    return Response.json({ data: answers.get(query) ?? null });
  };
  return { queries, fetcher };
}

const ALL_ANSWERS = new Map<string, unknown>([
  [BUDGET_QUERY, answer],
  [DATA_REQUESTS_QUERY, dataRequests],
  [DATA_USAGE_QUERY, dataUsage],
  [DATA_STORAGE_QUERY, dataStorage],
]);

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fake fetch that records requests and answers with `response`. */
function fakeFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    return response();
  };
  return { calls, fetcher };
}

describe("analytics collector", () => {
  it("is active only with both the token and the account ID", () => {
    const { fetcher } = fakeFetch(() => Response.json({}));
    expect(analyticsFromEnv({}, fetcher)).toBeNull();
    expect(analyticsFromEnv({ CF_ANALYTICS_TOKEN: TOKEN }, fetcher)).toBeNull();
    expect(analyticsFromEnv({ CF_ANALYTICS_TOKEN: " ", CF_ACCOUNT_ID: "acc" }, fetcher)).toBeNull();
    expect(
      analyticsFromEnv({ CF_ANALYTICS_TOKEN: TOKEN, CF_ACCOUNT_ID: "acc" }, fetcher),
    ).not.toBeNull();
  });

  it("queries the account's datasets for the cycle and classifies R2 operations", async () => {
    const { calls, fetcher } = fakeFetch(() => Response.json({ data: answer }));
    const collector = analyticsFromEnv(
      { CF_ANALYTICS_TOKEN: TOKEN, CF_ACCOUNT_ID: "acc_1" },
      fetcher,
    );
    // The same answer to every query: the data scripts ran no namespace, so the documents
    // objects used nothing and only one more request is made.
    expect(await collector?.collect(RANGE)).toEqual({
      r2ClassA: 150,
      r2ClassB: 1_000,
      storedBytes: 5_730,
      workerRequests: 1_500,
      d1RowsRead: 15,
      d1RowsWritten: 2,
      dataRequests: 0,
      dataGbSeconds: 0,
      dataRowsRead: 0,
      dataRowsWritten: 0,
    });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({
      query: DATA_REQUESTS_QUERY,
      variables: {
        accountTag: "acc_1",
        start: "2026-11-01T00:00:00.000Z",
        end: "2026-11-08T12:00:00.000Z",
        dataScripts: ["portifact-data"],
      },
    });
    const call = calls[0] as { url: string; init: RequestInit };
    expect(call.url).toBe(GRAPHQL_ENDPOINT);
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(call.init.body as string)).toEqual({
      query: BUDGET_QUERY,
      variables: {
        accountTag: "acc_1",
        start: "2026-11-01T00:00:00.000Z",
        end: "2026-11-08T12:00:00.000Z",
        startDate: "2026-11-01",
        endDate: "2026-11-08",
        buckets: ["portifact-artifacts", "eu_portifact-artifacts-eu"],
        scripts: ["portifact-app", "portifact-content", "portifact-jobs", "portifact-data"],
        databaseIds: [
          "6cf93803-aa3c-4859-9f58-e36e2fd784e3",
          "b5285aa9-aa8d-4c2c-9828-22e31c1aec9e",
          "fb06a466-a5c3-4fda-a1dc-af6a4e12c9a4",
          "5a29e108-935d-4e21-9429-a6bcde78659b",
        ],
      },
    });
  });

  it("leaves datasets missing from the answer unmeasured", () => {
    expect(parseBudgetData({ viewer: { accounts: [{}] } })).toEqual({});
    expect(parseBudgetData({ viewer: { accounts: [{ storage0: [{ max: {} }] }] } })).toEqual({
      storedBytes: 0,
    });
    expect(() => parseBudgetData({ viewer: { accounts: [] } })).toThrow(
      /ANALYTICS_ACCOUNT_NOT_VISIBLE/,
    );
    expect(() => parseBudgetData({})).toThrow(/ANALYTICS_ACCOUNT_NOT_VISIBLE/);
  });

  it("adds each bucket's latest storage sample and asks for them one field per bucket", () => {
    // The EU bucket alone has a sample, the default one is empty: its bytes are the total.
    expect(
      parseBudgetData({
        viewer: { accounts: [{ storage0: [], storage1: [{ max: { payloadSize: 9 } }] }] },
      }),
    ).toEqual({ storedBytes: 9 });
    // No bucket has a sample: unmeasured, never zero.
    expect(parseBudgetData({ viewer: { accounts: [{ storage0: [], storage1: [] }] } })).toEqual({});
    expect(BUDGET_QUERY).toContain(
      'storage0: r2StorageAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_lt: $end, bucketName: "portifact-artifacts" }',
    );
    expect(BUDGET_QUERY).toContain(
      'storage1: r2StorageAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_lt: $end, bucketName: "eu_portifact-artifacts-eu" }',
    );
    expect(BUDGET_QUERY).toContain("bucketName_in: $buckets");
  });

  it("fails without echoing the token or the response body", async () => {
    const collector = cloudflareAnalytics(
      { token: TOKEN, accountId: "acc" },
      fakeFetch(() => new Response(`bad token ${TOKEN}`, { status: 403 })).fetcher,
    );
    const error = await collector.collect(RANGE).catch((e: unknown) => e);
    expect(String(error)).toBe("Error: ANALYTICS_HTTP 403");
    // What the budget run logs: the code and the status, so a revoked token reads apart from a limit.
    expect(errorLabel(error)).toBe("Error:ANALYTICS_HTTP:403");

    const graphErrors = cloudflareAnalytics(
      { token: TOKEN, accountId: "acc" },
      fakeFetch(() => Response.json({ data: null, errors: [{ message: TOKEN }] })).fetcher,
    );
    expect(String(await graphErrors.collect(RANGE).catch((e: unknown) => e))).toBe(
      "Error: ANALYTICS_GRAPHQL_ERRORS 1",
    );

    const noData = cloudflareAnalytics(
      { token: TOKEN, accountId: "acc" },
      fakeFetch(() => Response.json({ errors: [] })).fetcher,
    );
    await expect(noData.collect(RANGE)).rejects.toThrow(/ANALYTICS_ACCOUNT_NOT_VISIBLE/);
  });

  it("measures the data Worker's Durable Objects in the namespaces its script ran in", async () => {
    const { queries, fetcher } = routedFetch(ALL_ANSWERS);
    const calls: string[] = [];
    const recording: Fetcher = async (url, init) => {
      calls.push(init.body as string);
      return fetcher(url, init);
    };
    const metrics = await cloudflareAnalytics(
      { token: TOKEN, accountId: "acc" },
      recording,
    ).collect(RANGE);
    expect(metrics).toMatchObject({
      workerRequests: 1_500,
      // 1,050 invocations plus 400 incoming WebSocket messages at 20 to 1.
      dataRequests: 1_070,
      // 2.5 active seconds at 128 MB.
      dataGbSeconds: 0.32,
      dataRowsRead: 1_020,
      dataRowsWritten: 300,
      // Each namespace's latest sample, newest first.
      dataStoredBytes: 12_000,
    });
    expect(queries).toEqual([
      BUDGET_QUERY,
      DATA_REQUESTS_QUERY,
      DATA_USAGE_QUERY,
      DATA_STORAGE_QUERY,
    ]);
    for (const body of calls.slice(2)) {
      expect(JSON.parse(body).variables.namespaceIds).toEqual(["ns-default", "ns-eu"]);
    }
    expect(DATA_REQUESTS_QUERY).toContain("scriptName_in: $dataScripts");
    expect(DATA_USAGE_QUERY).toContain("namespaceId_in: $namespaceIds");
    expect(DATA_STORAGE_QUERY).toContain("namespaceId_in: $namespaceIds");
  });

  it("keeps the platform's metrics when the data queries fail, and logs only a label", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = routedFetch(ALL_ANSWERS, new Map([[DATA_USAGE_QUERY, 500]]));
    const metrics = await cloudflareAnalytics(
      { token: TOKEN, accountId: "acc" },
      failed.fetcher,
    ).collect(RANGE);
    expect(metrics).toEqual(parseBudgetData(answer));
    expect(log.mock.calls.map((call) => String(call[0]))).toEqual([
      JSON.stringify({ event: "budget_data_analytics_failed", error: "Error:ANALYTICS_HTTP:500" }),
    ]);

    // Storage alone failing loses only the stored bytes.
    log.mockClear();
    const storage = routedFetch(ALL_ANSWERS, new Map([[DATA_STORAGE_QUERY, 429]]));
    const partial = await cloudflareAnalytics(
      { token: TOKEN, accountId: "acc" },
      storage.fetcher,
    ).collect(RANGE);
    expect(partial).toMatchObject({ dataRowsWritten: 300 });
    expect(partial).not.toHaveProperty("dataStoredBytes");
    expect(log.mock.calls.map((call) => String(call[0]))).toEqual([
      JSON.stringify({ event: "budget_data_storage_failed", error: "Error:ANALYTICS_HTTP:429" }),
    ]);

    // The platform's own query failing still fails the collection, as before.
    const platform = routedFetch(ALL_ANSWERS, new Map([[BUDGET_QUERY, 403]]));
    await expect(
      cloudflareAnalytics({ token: TOKEN, accountId: "acc" }, platform.fetcher).collect(RANGE),
    ).rejects.toThrow(/ANALYTICS_HTTP/);
  });

  it("leaves documents datasets missing from the answer unmeasured", () => {
    expect(parseDataRequests({ viewer: { accounts: [{}] } })).toEqual({
      invocations: 0,
      namespaceIds: [],
    });
    expect(() => parseDataRequests({})).toThrow(/ANALYTICS_ACCOUNT_NOT_VISIBLE/);
    expect(parseDataUsage(5, { viewer: { accounts: [{}] } })).toEqual({});
    expect(() => parseDataUsage(5, { viewer: { accounts: [] } })).toThrow(
      /ANALYTICS_ACCOUNT_NOT_VISIBLE/,
    );
    expect(
      parseDataUsage(5, { viewer: { accounts: [{ durableObjectsStorageGroups: [] }] } }),
    ).toEqual({});
    expect(
      parseDataUsage(5, {
        viewer: {
          accounts: [
            {
              durableObjectsPeriodicGroups: [{}],
              durableObjectsStorageGroups: [{ dimensions: { namespaceId: "a" } }, {}],
            },
          ],
        },
      }),
    ).toEqual({
      dataRequests: 5,
      dataGbSeconds: 0,
      dataRowsRead: 0,
      dataRowsWritten: 0,
      dataStoredBytes: 0,
    });
  });
});
