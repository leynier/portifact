// The Cloudflare custom hostnames client and the DNS over HTTPS lookup, against a fake `fetch`:
// what they send, how they read answers and failures, and that nothing is built without the
// explicit switch, the zone and the token.
import { describe, expect, it, vi } from "vitest";
import {
  CloudflareError,
  cloudflareHostnames,
  cloudflareStatus,
  customDomainsServing,
  dohPointing,
  dohTxt,
  dohZoneApex,
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
    CONTENT_DOMAIN: "portifact.dev",
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
      { ...on, CONTENT_DOMAIN: undefined },
    ]) {
      expect(domainDepsFromEnv(env, fetcher), JSON.stringify(env)).toBeNull();
    }
  });

  it("serves with the variable alone, and says loudly when the rest is missing", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(customDomainsServing(on)).toBe(true);
      expect(customDomainsServing({ CUSTOM_DOMAINS_ENABLED: "true" })).toBe(true);
      for (const value of [undefined, "1", "TRUE", "false"]) {
        expect(customDomainsServing({ CUSTOM_DOMAINS_ENABLED: value })).toBe(false);
      }
      expect(domainDepsFromEnv({ CUSTOM_DOMAINS_ENABLED: "true" }, fetcher)).toBeNull();
      expect(log.mock.calls.map((call) => call[0])).toEqual([
        JSON.stringify({ event: "custom_domains_misconfigured" }),
      ]);
      // Switched off, nothing is logged.
      domainDepsFromEnv({}, fetcher);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
});

describe("the client's details", () => {
  it("sends JSON without following redirects on every call", async () => {
    const { sent, fetcher } = fakeFetch(() => json({ success: true, result: [] }));
    const client = cloudflareHostnames(fetcher, ZONE, TOKEN);
    await client.list();
    await client.status("0a");
    await client.remove("0a");
    for (const call of sent) {
      expect(call.init?.redirect).toBe("manual");
      expect((call.init?.headers as Record<string, string> | undefined)?.["content-type"]).toBe(
        "application/json",
      );
    }
    expect(sent).toHaveLength(3);
  });

  it("names every Cloudflare code, and none when the body has none", async () => {
    const codes = cloudflareHostnames(
      fakeFetch(() => json({ success: false, errors: [{ code: 1406 }, { code: 1407 }] }, 409))
        .fetcher,
      ZONE,
      TOKEN,
    );
    await expect(codes.create("a.example.com")).rejects.toThrow(
      /^Cloudflare custom hostnames: 409 1406,1407$/,
    );
    const bare = cloudflareHostnames(fakeFetch(() => json({}, 500)).fetcher, ZONE, TOKEN);
    const error = (await bare.create("a.example.com").catch((e: unknown) => e)) as CloudflareError;
    expect(error.message).toBe("Cloudflare custom hostnames: 500 ");
    expect(error.codes).toEqual([]);
    const missing = cloudflareHostnames(fakeFetch(() => json({}, 404)).fetcher, ZONE, TOKEN);
    const notFound = (await missing
      .create("a.example.com")
      .catch((e: unknown) => e)) as CloudflareError;
    expect([notFound.status, notFound.codes]).toEqual([404, []]);
    // A list with nothing on its first page is empty, not an error.
    expect(await missing.list()).toEqual([]);
  });

  it("stops listing on a short page", async () => {
    const page = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ id: `${i}`, hostname: `h${i}.example.com` }));
    const { sent, fetcher } = fakeFetch(() => json({ success: true, result: page(50) }));
    let calls = 0;
    const limited: Fetch = async (url, init) => {
      calls += 1;
      return calls < 3 ? fetcher(url, init) : json({ success: true, result: page(49) });
    };
    expect(await cloudflareHostnames(limited, ZONE, TOKEN).list()).toHaveLength(149);
    expect(sent).toHaveLength(2);
  });

  it("checks zone and hostname IDs whole", async () => {
    const fetcher = fakeFetch(() => json({})).fetcher;
    for (const zone of [`x${ZONE}`, `${ZONE}x`, ZONE.toUpperCase()]) {
      expect(() => cloudflareHostnames(fetcher, zone, TOKEN), zone).toThrow(
        "CF_CONTENT_ZONE_ID is not a zone ID",
      );
    }
    const client = cloudflareHostnames(fetcher, ZONE, TOKEN);
    for (const id of ["/0a", "0a/", "0a?x", "x0a", "0ax"]) {
      await expect(client.status(id), id).rejects.toThrow("Not a custom hostname ID");
    }
  });

  it("needs a token of at least 20 characters", () => {
    const fetcher: Fetch = async () => json({});
    const on = {
      CUSTOM_DOMAINS_ENABLED: "true",
      CF_CONTENT_ZONE_ID: ZONE,
      CONTENT_DOMAIN: "portifact.dev",
    };
    expect(
      domainDepsFromEnv({ ...on, CF_HOSTNAMES_TOKEN: "t".repeat(20) }, fetcher),
    ).not.toBeNull();
    expect(domainDepsFromEnv({ ...on, CF_HOSTNAMES_TOKEN: "t".repeat(19) }, fetcher)).toBeNull();
  });

  it("reads a DNS answer without an Answer section as no values", async () => {
    expect(await dohTxt(fakeFetch(() => json({ Status: 0, Answer: [] })).fetcher)("x")).toEqual([]);
  });
});

describe("zone apexes over DNS over HTTPS", () => {
  it("is an apex only when the SOA answer names the hostname itself", async () => {
    const answer = (Answer: unknown[]) => fakeFetch(() => json({ Status: 0, Answer })).fetcher;
    const { sent, fetcher } = fakeFetch(() =>
      json({
        Status: 0,
        Answer: [{ name: "Example.co.uk.", type: 6, data: "ns. host. 1 2 3 4 5" }],
      }),
    );
    expect(await dohZoneApex(fetcher)("example.co.uk")).toBe(true);
    expect(sent[0]?.url).toBe("https://cloudflare-dns.com/dns-query?name=example.co.uk&type=SOA");
    expect(sent[0]?.init?.redirect).toBe("manual");
    // A name inside a zone gets no SOA answer of its own; a CNAME's target zone has another name.
    expect(await dohZoneApex(answer([]))("docs.example.co.uk")).toBe(false);
    expect(
      await dohZoneApex(
        answer([
          { name: "docs.example.com.", type: 5, data: "domains.portifact.dev." },
          { name: "portifact.dev.", type: 6, data: "x" },
        ]),
      )("docs.example.com"),
    ).toBe(false);
    expect(
      await dohZoneApex(answer([{ name: "docs.example.com.", type: 5, data: "x" }]))(
        "docs.example.com",
      ),
    ).toBe(false);
    expect(await dohZoneApex(fakeFetch(() => json({ Status: 0 })).fetcher)("x.example")).toBe(
      false,
    );
    expect(await dohZoneApex(fakeFetch(() => json({ Status: 3 })).fetcher)("x.example")).toBe(
      false,
    );
    await expect(
      dohZoneApex(fakeFetch(() => json({ Status: 2 })).fetcher)("x.example"),
    ).rejects.toThrow("rcode 2");
    await expect(dohZoneApex(fakeFetch(() => json({}, 500)).fetcher)("x.example")).rejects.toThrow(
      "500",
    );
  });
});

describe("where a name points", () => {
  const TARGET = "domains.portifact.dev";
  /** Answers per `name type` pair; anything else is an empty NOERROR. */
  const dns = (records: Record<string, { type: number; data: string }[] | number>) =>
    fakeFetch((url) => {
      const query = new URL(url).searchParams;
      const found = records[`${query.get("name")} ${query.get("type")}`];
      if (typeof found === "number") return json({ Status: found });
      return json({ Status: 0, Answer: found ?? [] });
    });

  it("follows the CNAME chain to the target, without following HTTP redirects", async () => {
    const { sent, fetcher } = dns({
      "docs.example.com A": [
        { type: 5, data: "Domains.Portifact.dev." },
        { type: 1, data: "203.0.113.7" },
      ],
    });
    expect(await dohPointing(fetcher, TARGET)("docs.example.com")).toBe(true);
    expect(sent.map((call) => call.url)).toEqual([
      "https://cloudflare-dns.com/dns-query?name=docs.example.com&type=A",
      "https://cloudflare-dns.com/dns-query?name=docs.example.com&type=AAAA",
    ]);
    expect(sent.every((call) => call.init?.redirect === "manual")).toBe(true);
  });

  it("accepts flattened or proxied addresses only when every one is the target's", async () => {
    const target = {
      "domains.portifact.dev A": [{ type: 1, data: "198.51.100.1" }],
      "domains.portifact.dev AAAA": [{ type: 28, data: "2001:db8::1" }],
    };
    const flattened = dns({
      ...target,
      "docs.example.com A": [{ type: 1, data: "198.51.100.1" }],
      "docs.example.com AAAA": [{ type: 28, data: "2001:db8::1" }],
    });
    expect(await dohPointing(flattened.fetcher, TARGET)("docs.example.com")).toBe(true);
    const mixed = dns({
      ...target,
      "docs.example.com A": [
        { type: 1, data: "198.51.100.1" },
        { type: 1, data: "203.0.113.7" },
      ],
    });
    expect(await dohPointing(mixed.fetcher, TARGET)("docs.example.com")).toBe(false);
    const other = dns({
      ...target,
      "docs.example.com A": [
        { type: 5, data: "own-server.example.net." },
        { type: 1, data: "203.0.113.7" },
      ],
    });
    expect(await dohPointing(other.fetcher, TARGET)("docs.example.com")).toBe(false);
  });

  it("says elsewhere for a name that does not resolve, and throws when DNS fails", async () => {
    const gone = dns({ "docs.example.com A": 3, "docs.example.com AAAA": 3 });
    expect(await dohPointing(gone.fetcher, TARGET)("docs.example.com")).toBe(false);
    // No answers at all asks nothing about the target.
    expect(gone.sent).toHaveLength(2);
    const failing = dns({ "docs.example.com A": 2 });
    await expect(dohPointing(failing.fetcher, TARGET)("docs.example.com")).rejects.toThrow(
      "rcode 2",
    );
    const down = fakeFetch(() => json({}, 503));
    await expect(dohPointing(down.fetcher, TARGET)("docs.example.com")).rejects.toThrow("503");
  });
});
