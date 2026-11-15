// The documents objects' storage reports, kept per isolate and written in one batch per window.
import { describe, expect, it } from "vitest";
import { StorageReports } from "../src/data-storage.ts";

describe("storage reports", () => {
  it("keeps the newest report per artifact and writes them once per window", async () => {
    const written: Map<string, unknown>[] = [];
    const reports = new StorageReports(async (pending) => {
      written.push(pending);
    }, 0);
    const scheduled: Promise<unknown>[] = [];
    const waitUntil = (promise: Promise<unknown>) => scheduled.push(promise);
    reports.keep("a", { generation: 0, seq: 5, bytes: 10 }, waitUntil);
    reports.keep("a", { generation: 0, seq: 3, bytes: 99 }, waitUntil);
    reports.keep("a", { generation: 1, seq: 1, bytes: 20 }, waitUntil);
    reports.keep("b", { generation: 0, seq: 1, bytes: 1 }, waitUntil);
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
    expect(written).toEqual([
      new Map([
        ["a", { generation: 1, seq: 1, bytes: 20 }],
        ["b", { generation: 0, seq: 1, bytes: 1 }],
      ]),
    ]);
    await reports.flush();
    expect(written).toHaveLength(1);
  });

  it("keeps the reports for the next window when the write fails", async () => {
    let fail = true;
    const written: Map<string, unknown>[] = [];
    const reports = new StorageReports(async (pending) => {
      if (fail) throw new Error("D1 unavailable");
      written.push(pending);
    }, 0);
    reports.keep("a", { generation: 0, seq: 2, bytes: 5 }, () => {});
    await reports.flush();
    expect(reports.pending().get("a")).toEqual({ generation: 0, seq: 2, bytes: 5 });
    fail = false;
    await reports.flush();
    expect(written).toHaveLength(1);
  });
});
