import { errorLabel } from "@portifact/domain";
import { describe, expect, it } from "vitest";
import {
  analyticsFromEnv,
  BUDGET_QUERY,
  cloudflareAnalytics,
  type Fetcher,
  GRAPHQL_ENDPOINT,
  parseBudgetData,
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
        r2StorageAdaptiveGroups: [{ max: { payloadSize: 5_000, metadataSize: 25 } }],
        workersInvocationsAdaptive: [{ sum: { requests: 1_000 } }, { sum: { requests: 500 } }],
        d1AnalyticsAdaptiveGroups: [
          { sum: { rowsRead: 10, rowsWritten: 2 } },
          { sum: { rowsRead: 5 } },
        ],
      },
    ],
  },
};

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
    expect(await collector?.collect(RANGE)).toEqual({
      r2ClassA: 150,
      r2ClassB: 1_000,
      storedBytes: 5_025,
      workerRequests: 1_500,
      d1RowsRead: 15,
      d1RowsWritten: 2,
    });
    expect(calls).toHaveLength(1);
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
        bucket: "portifact-artifacts",
        scripts: ["portifact-app", "portifact-content", "portifact-jobs"],
        databaseIds: [
          "6cf93803-aa3c-4859-9f58-e36e2fd784e3",
          "b5285aa9-aa8d-4c2c-9828-22e31c1aec9e",
        ],
      },
    });
  });

  it("leaves datasets missing from the answer unmeasured", () => {
    expect(parseBudgetData({ viewer: { accounts: [{}] } })).toEqual({});
    expect(
      parseBudgetData({ viewer: { accounts: [{ r2StorageAdaptiveGroups: [{ max: {} }] }] } }),
    ).toEqual({ storedBytes: 0 });
    expect(() => parseBudgetData({ viewer: { accounts: [] } })).toThrow(
      /ANALYTICS_ACCOUNT_NOT_VISIBLE/,
    );
    expect(() => parseBudgetData({})).toThrow(/ANALYTICS_ACCOUNT_NOT_VISIBLE/);
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
});
