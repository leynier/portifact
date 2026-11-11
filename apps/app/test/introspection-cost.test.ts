// What checking a bearer token costs in D1 (decision 0021). Every API and MCP request with a
// token pays it, so it is pinned: the provider seeds its resource rows once per adapter object,
// and a watched adapter made fresh for each check made it read them again every time.
import { env } from "cloudflare:workers";
import { aliasBinding } from "@portifact/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_CLIENT_ID } from "../src/auth/config.ts";
import { AUTH_TIME_CLAIM } from "../src/auth/introspection.ts";
import { approveDevice, pollDeviceToken, requestDeviceCode } from "./flows.ts";
import { createHarness, type Harness } from "./harness.ts";

const SCOPES = "artifacts:read artifacts:write offline_access";

/** `env.DB`, remembering the statements prepared on it. */
function recording(binding: D1Database): { database: D1Database; taken(): string[] } {
  let queries: string[] = [];
  const proxy = new Proxy(binding, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          queries.push(query);
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    database: aliasBinding(proxy, binding),
    taken() {
      const seen = queries;
      queries = [];
      return seen;
    },
  };
}

async function cliToken(h: Harness, email: string): Promise<string> {
  const device = await requestDeviceCode(h, CLI_CLIENT_ID, SCOPES);
  const approved = await approveDevice(h, await h.signIn(email), device.user_code);
  expect(approved.status, await approved.clone().text()).toBe(200);
  // The provider refuses a poll that comes sooner than the interval it gave.
  vi.setSystemTime(Date.now() + device.interval * 1000);
  const issued = await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code);
  expect(issued.status, await issued.clone().text()).toBe(200);
  return (await issued.json<{ access_token: string }>()).access_token;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the D1 cost of checking a token", () => {
  it("reads the provider's resource rows once per instance, not once per check", async () => {
    const { database, taken } = recording(env.DB);
    const h = createHarness({ env: { DB: database } });
    const token = await cliToken(h, "introspection-cost@example.test");
    const check = async () => {
      taken();
      const payload = (await h.auth.api.introspectBearer({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      })) as Record<string, unknown>;
      expect(payload).toMatchObject({ active: true });
      // The sign-in time still comes with the row the provider read.
      expect(payload[AUTH_TIME_CLAIM]).toBeTypeOf("number");
      return taken();
    };
    await check();
    const second = await check();
    const third = await check();
    // A warm check never seeds: its statements are the same every time, with no repeats beyond
    // the provider's own (the token, its client, its user and the token's resource).
    expect(third).toEqual(second);
    const seeding = second.filter((query) => /from "oauth_resources?"/i.test(query));
    expect(seeding.length, second.join("\n")).toBeLessThanOrEqual(2);
    expect(second.length, second.join("\n")).toBe(WARM_CHECK_STATEMENTS);
  });

  it("keeps concurrent checks apart: each gets its own token's row", async () => {
    const h = createHarness();
    const first = await cliToken(h, "introspection-a@example.test");
    const second = await cliToken(h, "introspection-b@example.test");
    const record = (token: string) =>
      h.auth.api.tokenRecordOf({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      }) as Promise<{ accessId: string } | null>;
    const alone = [await record(first), await record(second)];
    const together = await Promise.all(
      Array.from({ length: 12 }, (_, index) => record(index % 2 === 0 ? first : second)),
    );
    expect(alone[0]?.accessId).not.toBe(alone[1]?.accessId);
    together.forEach((found, index) => {
      expect(found?.accessId).toBe(alone[index % 2]?.accessId);
    });
  });
});

/** Measured on the release before the watched adapter (v0.32.0): token, client, user, resource x2. */
const WARM_CHECK_STATEMENTS = 5;
