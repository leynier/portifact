import { describe, expect, it } from "vitest";
import { cloudflareHostnames, dohTxt } from "../src/cloudflare.ts";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return answer(call);
  };
  return { calls, fetcher };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const BASE = "https://api.cloudflare.com/client/v4/zones/zone123/custom_hostnames";

describe("custom hostnames client", () => {
  it("creates with HTTP DCV and a bearer token", async () => {
    const { calls, fetcher } = fakeFetch(() => json({ success: true, result: { id: "h1" } }));
    const client = cloudflareHostnames(fetcher, "zone123", "secret-token");
    expect(await client.create("docs.example.com")).toEqual({ id: "h1" });
    expect(calls[0]?.url).toBe(BASE);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      hostname: "docs.example.com",
      ssl: { method: "http", type: "dv" },
    });
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer secret-token");
  });

  it("reports active only when the hostname and its certificate both are", async () => {
    const answers = [
      { status: "active", ssl: { status: "active" } },
      { status: "active", ssl: { status: "pending_validation" } },
      { status: "pending" },
      { status: "moved" },
    ];
    let i = 0;
    const { fetcher } = fakeFetch(() => json({ success: true, result: answers[i++] }));
    const client = cloudflareHostnames(fetcher, "zone123", "t");
    expect(await client.status("h1")).toBe("active");
    expect(await client.status("h1")).toBe("pending");
    expect(await client.status("h1")).toBe("pending");
    expect(await client.status("h1")).toBe("moved");
    const missing = cloudflareHostnames(
      fakeFetch(() => new Response(null, { status: 404 })).fetcher,
      "zone123",
      "t",
    );
    expect(await missing.status("h1")).toBe("missing");
  });

  it("deletes idempotently and lists every page", async () => {
    const page = (n: number) =>
      Array.from({ length: n }, (_, k) => ({
        id: `h${k}`,
        hostname: `h${k}.example.com`,
        extra: 1,
      }));
    const { calls, fetcher } = fakeFetch(({ init, url }) => {
      if (init?.method === "DELETE") return new Response(null, { status: 404 });
      return json({ success: true, result: url.includes("page=1") ? page(50) : page(3) });
    });
    const client = cloudflareHostnames(fetcher, "zone123", "t");
    await client.remove("gone");
    expect(calls[0]?.url).toBe(`${BASE}/gone`);
    const all = await client.list();
    expect(all).toHaveLength(53);
    expect(all[0]).toEqual({ id: "h0", hostname: "h0.example.com" });
  });

  it("throws with Cloudflare's codes and never the token", async () => {
    const { fetcher } = fakeFetch(() =>
      json({ success: false, errors: [{ code: 1406, message: "x" }] }, 409),
    );
    const client = cloudflareHostnames(fetcher, "zone123", "secret-token");
    const error = await client.create("docs.example.com").catch((e: Error) => e);
    expect(String(error)).toContain("409 1406");
    expect(String(error)).not.toContain("secret-token");
    const notFound = cloudflareHostnames(
      fakeFetch(() => new Response(null, { status: 404 })).fetcher,
      "z",
      "t",
    );
    await expect(notFound.create("docs.example.com")).rejects.toThrow("404");
  });
});

describe("TXT over DNS over HTTPS", () => {
  it("joins quoted strings and keeps only TXT answers", async () => {
    const { calls, fetcher } = fakeFetch(() =>
      json({
        Status: 0,
        Answer: [
          { type: 16, data: '"portifact-verify=" "abc"' },
          { type: 16, data: '"v=spf1 -all"' },
          { type: 5, data: "target.example." },
        ],
      }),
    );
    expect(await dohTxt(fetcher)("_portifact.docs.example.com")).toEqual([
      "portifact-verify=abc",
      "v=spf1 -all",
    ]);
    expect(calls[0]?.url).toBe(
      "https://cloudflare-dns.com/dns-query?name=_portifact.docs.example.com&type=TXT",
    );
  });

  it("answers nothing for NXDOMAIN and throws on a failed lookup", async () => {
    expect(await dohTxt(fakeFetch(() => json({ Status: 3 })).fetcher)("x")).toEqual([]);
    expect(await dohTxt(fakeFetch(() => json({ Status: 0 })).fetcher)("x")).toEqual([]);
    await expect(
      dohTxt(fakeFetch(() => new Response(null, { status: 502 })).fetcher)("x"),
    ).rejects.toThrow("502");
  });
});
