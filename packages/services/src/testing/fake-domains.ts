// An in-memory stand-in for Cloudflare and DNS (decision 0006), for tests and the e2e stack.
// Exported as @portifact/services/testing, never from the package's main entry, so no Worker
// that serves production can reach it.
import type { CloudflareStatus } from "@portifact/domain";
import {
  CloudflareError,
  type CustomHostnames,
  type DomainDeps,
  type TxtLookup,
} from "../cloudflare-hostnames.ts";

/**
 * An in-memory stand-in for Cloudflare and DNS, for tests and the e2e stack. Hostnames start
 * `pending`; `activate` and `setStatus` move them, `publishTxt` and `clearTxt` change DNS, and
 * `fail` makes the next calls throw like an outage.
 */
export class FakeDomains implements DomainDeps {
  readonly records = new Map<string, string[]>();
  readonly created = new Map<string, { hostname: string; status: CloudflareStatus }>();
  readonly calls: string[] = [];
  failing: { hostnames: boolean; txt: boolean } = { hostnames: false, txt: false };

  readonly hostnames: CustomHostnames = {
    create: async (hostname) => {
      this.#outage("create");
      if ([...this.created.values()].some((entry) => entry.hostname === hostname)) {
        throw new CloudflareError(409, [1406]);
      }
      // Unique across fakes, like Cloudflare's IDs, so tests sharing a database never collide.
      const id = crypto.randomUUID();
      this.created.set(id, { hostname, status: "pending" });
      return { id };
    },
    status: async (id) => {
      this.#outage("status");
      return this.created.get(id)?.status ?? "missing";
    },
    remove: async (id) => {
      this.#outage("remove");
      this.created.delete(id);
    },
    list: async () => {
      this.#outage("list");
      return [...this.created].map(([id, entry]) => ({ id, hostname: entry.hostname }));
    },
  };

  readonly txt: TxtLookup = async (name) => {
    this.calls.push(`txt ${name}`);
    if (this.failing.txt) throw new Error("DNS over HTTPS: 503");
    return this.records.get(name) ?? [];
  };

  #outage(call: string) {
    this.calls.push(call);
    if (this.failing.hostnames) throw new CloudflareError(503, []);
  }

  publishTxt(name: string, value: string) {
    this.records.set(name, [...(this.records.get(name) ?? []), value]);
  }

  clearTxt(name: string) {
    this.records.delete(name);
  }

  /** The Cloudflare ID of a hostname, if one exists. */
  idOf(hostname: string): string | undefined {
    return [...this.created].find(([, entry]) => entry.hostname === hostname)?.[0];
  }

  setStatus(hostname: string, status: CloudflareStatus) {
    const id = this.idOf(hostname);
    if (id === undefined) throw new Error(`No Cloudflare hostname for ${hostname}`);
    this.created.set(id, { hostname, status });
  }

  activate(hostname: string) {
    this.setStatus(hostname, "active");
  }
}
