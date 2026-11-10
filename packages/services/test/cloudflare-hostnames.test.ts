// The Cloudflare custom hostnames client and the DNS over HTTPS lookup, against a fake `fetch`:
// what they send, how they read answers and failures, and that nothing is built without the
// explicit switch, the zone and the token.
import { describe, expect, it } from "vitest";
import {
  CloudflareError,
  cloudflareHostnames,
  cloudflareStatus,
  dohTxt,
  domainDepsFromEnv,
  type Fetch,
} from "../src/cloudflare-hostnames.ts";

const ZONE = "0123456789abcdef0123456789abcdef";
const TOKEN = "test-token-not-a-credential";

interface Sent {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(answer: (url: string, init?: RequestInit) => Response) {
  const sent: Sent[] = [];
  const fetcher: Fetch = async (url, init) => {
    sent.push({ url, init });
    return answer(url, init);
  };
  return { sent, fetcher };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("custom hostnames", () => {
  it("creates with HTTP validation on the zone, with the token only in the header", async () => {
    const { sent, fetcher } = fakeFetch(() => json({ success: true, result: { id: "abc-123" } }));
    const client = cloudflareHostnames(fetcher, ZONE, TOKEN);
    expect(await client.create("docs.example.com")).toEqual({ id: "abc-123" });
    const [call] = sent;
    expect(call?.url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE}/custom_hostnames`);
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.redirect).toBe("manual");
    expect(JSON.parse(call?.init?.body as string)).toEqual({
      hostname: "docs.example.com",
      ssl: { method: "http", type: "dv" },
    });
    expect((call?.init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(call?.url).not.toContain(TOKEN);
  });

  it("reports failures with Cloudflare's status and codes only", async () => {
    const client = cloudflareHostnames(
      fakeFetch(() => json({ success: false, errors: [{ code: 1406, message: TOKEN }] }, 409))
        .fetcher,
      ZONE,
      TOKEN,
    );
    const error = await client.create("docs.example.com").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareError);
    expect((error as CloudflareError).message).toBe("Cloudflare custom hostnames: 409 1406");
    expect((error as CloudflareError).message).not.toContain(TOKEN);
    const broken = cloudflareHostnames(
      fakeFetch(() => new Response("<html>", { status: 502 })).fetcher,
      ZONE,
      TOKEN,
    );
    await expect(broken.status("abc")).rejects.toThrow("502");
    const notFound = cloudflareHostnames(fakeFetch(() => json({}, 404)).fetcher, ZONE, TOKEN);
    await expect(notFound.create("docs.example.com")).rejects.toThrow("404");
    // A 200 that says it failed is a failure too.
    const refused = cloudflareHostnames(
      fakeFetch(() => json({ success: false, result: null })).fetcher,
      ZONE,
      TOKEN,
    );
    await expect(refused.list()).rejects.toThrow("200");
  });

  it("reads the hostname's status, and a missing one", async () => {
    const answers: Record<string, Response> = {};
    const { sent, fetcher } = fakeFetch(
      (url) => answers[url.split("/").pop() as string] ?? json({}, 404),
    );
    const client = cloudflareHostnames(fetcher, ZONE, TOKEN);
    answers["0a"] = json({
      success: true,
      result: { status: "active", ssl: { status: "active" } },
    });
    expect(await client.status("0a")).toBe("active");
    expect(await client.status("dead")).toBe("missing");
    expect(sent[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/zones/${ZONE}/custom_hostnames/0a`,
    );
    await expect(client.status("../../zones")).rejects.toThrow("Not a custom hostname ID");
  });

  it("maps Cloudflare's states", () => {
    expect(cloudflareStatus({ status: "active", ssl: { status: "active" } })).toBe("active");
    expect(cloudflareStatus({ status: "active", ssl: { status: "pending_validation" } })).toBe(
      "pending",
    );
    expect(cloudflareStatus({ status: "active" })).toBe("pending");
    expect(cloudflareStatus({ status: "pending" })).toBe("pending");
    expect(cloudflareStatus({ status: "moved" })).toBe("moved");
    expect(cloudflareStatus({ status: "deleted" })).toBe("deleted");
    expect(cloudflareStatus({ status: "blocked" })).toBe("blocked");
    expect(cloudflareStatus({ status: "test_pending" })).toBe("pending");
  });

  it("deletes, treating a hostname already gone as deleted", async () => {
    const { sent, fetcher } = fakeFetch((url) =>
      url.endsWith("/dead") ? json({}, 404) : json({ success: true, result: { id: "x" } }),
    );
    const client = cloudflareHostnames(fetcher, ZONE, TOKEN);
    await client.remove("abc");
    await client.remove("dead");
    expect(sent.map((s) => s.init?.method)).toEqual(["DELETE", "DELETE"]);
  });

  it("lists every page", async () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `${n}-${i}`,
        hostname: `h${n}-${i}.example.com`,
        extra: 1,
      }));
    const { sent, fetcher } = fakeFetch((url) => {
      const n = Number(new URL(url).searchParams.get("page"));
      return json({ success: true, result: n === 1 ? page(1, 50) : page(2, 3) });
    });
    const all = await cloudflareHostnames(fetcher, ZONE, TOKEN).list();
    expect(all).toHaveLength(53);
    expect(all[52]).toEqual({ id: "2-2", hostname: "h2-2.example.com" });
    expect(sent.map((s) => new URL(s.url).search)).toEqual([
      "?per_page=50&page=1",
      "?per_page=50&page=2",
    ]);
  });

  it("refuses a zone that is not a zone ID", () => {
    expect(() => cloudflareHostnames(fakeFetch(() => json({})).fetcher, "../x", TOKEN)).toThrow();
  });
});

describe("TXT over DNS over HTTPS", () => {
  it("joins quoted strings and keeps only TXT answers", async () => {
    const { sent, fetcher } = fakeFetch(() =>
      json({
        Status: 0,
        Answer: [
          { type: 16, data: '"portifact-verify=" "abc"' },
          { type: 16, data: '"other \\"quoted\\""' },
          { type: 5, data: "domains.portifact.dev." },
        ],
      }),
    );
    expect(await dohTxt(fetcher)("_portifact.docs.example.com")).toEqual([
      "portifact-verify=abc",
      'other \\"quoted\\"',
    ]);
    expect(sent[0]?.url).toBe(
      "https://cloudflare-dns.com/dns-query?name=_portifact.docs.example.com&type=TXT",
    );
    expect((sent[0]?.init?.headers as Record<string, string> | undefined)?.accept).toBe(
      "application/dns-json",
    );
  });

  it("answers nothing for a missing name and throws when the resolver fails", async () => {
    expect(await dohTxt(fakeFetch(() => json({ Status: 3 })).fetcher)("x")).toEqual([]);
    expect(await dohTxt(fakeFetch(() => json({ Status: 0 })).fetcher)("x")).toEqual([]);
    await expect(dohTxt(fakeFetch(() => json({ Status: 2 })).fetcher)("x")).rejects.toThrow(
      "rcode 2",
    );
    await expect(dohTxt(fakeFetch(() => json({}, 503)).fetcher)("x")).rejects.toThrow("503");
  });
});

describe("the switch", () => {
  const fetcher: Fetch = async () => json({});
  const on = {
    CUSTOM_DOMAINS_ENABLED: "true",
    CF_CONTENT_ZONE_ID: ZONE,
    CF_HOSTNAMES_TOKEN: TOKEN,
  };

  it("builds the clients only with the variable, the zone and the token", () => {
    expect(domainDepsFromEnv(on, fetcher)).not.toBeNull();
    for (const env of [
      {},
      { ...on, CUSTOM_DOMAINS_ENABLED: undefined },
      { ...on, CUSTOM_DOMAINS_ENABLED: "1" },
      { ...on, CUSTOM_DOMAINS_ENABLED: "TRUE" },
      { ...on, CF_CONTENT_ZONE_ID: undefined },
      { ...on, CF_CONTENT_ZONE_ID: "zone" },
      { ...on, CF_HOSTNAMES_TOKEN: undefined },
      { ...on, CF_HOSTNAMES_TOKEN: "short" },
    ]) {
      expect(domainDepsFromEnv(env, fetcher), JSON.stringify(env)).toBeNull();
    }
  });
});
