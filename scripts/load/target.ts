// What the load test runs against: the local e2e Worker (e2e/load/local.ts) or a remote
// deployment such as staging. Scenarios only see this interface.
import { readdirSync, readFileSync } from "node:fs";
import { type Body, type Sent, send } from "./http.ts";

/** How API calls authenticate: the dashboard session cookie locally, a bearer token remotely. */
export type Auth = { kind: "cookie"; cookie: string } | { kind: "bearer"; token: string };

export interface SeedUser {
  userId: string;
  email: string;
  auth: Auth;
}

export interface SeedPublishInput {
  ownerId: string;
  name: string;
  files: Record<string, string>;
  accessMode?: "public" | "authenticated" | "restricted";
  readers?: string[];
  annotations?: "off" | "open" | "locked";
}

/** Shortcuts only the local stack has, through the e2e Worker's control host. */
export interface Seeder {
  user(email: string): Promise<SeedUser>;
  publish(input: SeedPublishInput): Promise<{ artifactId: string; versionId: string }>;
  sql(query: string, params?: (string | number | null)[]): Promise<Record<string, unknown>[]>;
  /** A document-level thread written `agoMs` in the past, past any human check. */
  thread(input: {
    userId: string;
    artifactId: string;
    versionId: string;
    body: string;
    agoMs: number;
  }): Promise<void>;
}

export interface RequestInput {
  method: string;
  /** The URL as the Worker sees it, for example https://app.example/api/v1/usage. */
  url: string;
  headers?: Record<string, string>;
  body?: Body;
  discardBody?: boolean;
}

export interface Target {
  kind: "local" | "remote";
  appOrigin: string;
  contentDomain: string;
  request(input: RequestInput): Promise<Sent>;
  /** Sends a presigned upload: to its URL remotely, to the local storage stand-in locally. */
  upload(url: string, headers: Record<string, string>, body: Body): Promise<Sent>;
  seed: Seeder | null;
  /** Resident memory of the load test and, locally, of the Worker processes it started. */
  memoryBytes(): number;
  close(): Promise<void>;
}

export function remoteTarget(appOrigin: string, contentDomain: string): Target {
  return {
    kind: "remote",
    appOrigin,
    contentDomain,
    request: (input) => send(input),
    upload: (url, headers, body) => send({ method: "PUT", url, headers, body }),
    seed: null,
    memoryBytes: () => treeRss(process.pid),
    async close() {},
  };
}

/**
 * Resident memory of a process and its descendants, from /proc on Linux. Elsewhere it falls back
 * to this process alone, which misses a local workerd child.
 */
export function treeRss(root: number): number {
  try {
    const children = new Map<number, number[]>();
    const rss = new Map<number, number>();
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const status = readFileSync(`/proc/${entry}/status`, "utf8");
        const parent = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]);
        const kb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
        rss.set(Number(entry), kb * 1024);
        children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
      } catch {
        // The process ended while we read it.
      }
    }
    let total = 0;
    const queue = [root];
    while (queue.length > 0) {
      const pid = queue.pop() as number;
      total += rss.get(pid) ?? 0;
      queue.push(...(children.get(pid) ?? []));
    }
    return total || process.memoryUsage().rss;
  } catch {
    return process.memoryUsage().rss;
  }
}
