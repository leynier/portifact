// The two outside services the app and jobs Workers would call, written against their documented
// shapes and tested only with a fake `fetch`: no Cloudflare resource is ever touched by the spike.
import type { CustomHostnames, TxtLookup } from "./domains.ts";

const API = "https://api.cloudflare.com/client/v4";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
}

/**
 * Custom hostnames on one zone, with a token that holds only "SSL and Certificates Write" on
 * that zone (the permission the create endpoint documents). The token is never logged; errors
 * carry Cloudflare's codes only.
 */
export function cloudflareHostnames(
  fetcher: Fetch,
  zoneId: string,
  token: string,
): CustomHostnames {
  const call = async <T>(path: string, init: RequestInit = {}): Promise<Envelope<T> | null> => {
    const response = await fetcher(`${API}/zones/${zoneId}/custom_hostnames${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    if (response.status === 404) return null;
    const body = (await response.json()) as Envelope<T>;
    if (!response.ok || !body.success) {
      const codes = (body.errors ?? []).map((e) => e.code).join(",");
      throw new Error(`Cloudflare custom hostnames: ${response.status} ${codes}`);
    }
    return body;
  };
  return {
    async create(hostname) {
      // HTTP DCV: the customer's CNAME is already in place when Portifact creates the hostname
      // (it is created only after the TXT proof), so the certificate validates without a record.
      const body = await call<{ id: string }>("", {
        method: "POST",
        body: JSON.stringify({ hostname, ssl: { method: "http", type: "dv" } }),
      });
      if (!body) throw new Error("Cloudflare custom hostnames: 404");
      return { id: body.result.id };
    },
    async status(id) {
      const body = await call<{ status: string; ssl?: { status?: string } }>(`/${id}`);
      if (!body) return "missing";
      const { status, ssl } = body.result;
      if (status === "active") return ssl?.status === "active" ? "active" : "pending";
      if (status === "moved" || status === "deleted" || status === "blocked") return status;
      return "pending";
    },
    async remove(id) {
      await call(`/${id}`, { method: "DELETE" });
    },
    async list() {
      const all: { id: string; hostname: string }[] = [];
      for (let page = 1; ; page += 1) {
        const body = await call<{ id: string; hostname: string }[]>(`?per_page=50&page=${page}`);
        const results = body?.result ?? [];
        all.push(...results.map(({ id, hostname }) => ({ id, hostname })));
        if (results.length < 50) return all;
      }
    },
  };
}

/** TXT records through Cloudflare's DNS over HTTPS JSON API, never cached by Portifact. */
export function dohTxt(fetcher: Fetch): TxtLookup {
  return async (name) => {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`;
    const response = await fetcher(url, { headers: { accept: "application/dns-json" } });
    if (!response.ok) throw new Error(`DNS over HTTPS: ${response.status}`);
    const body = (await response.json()) as {
      Status: number;
      Answer?: { type: number; data: string }[];
    };
    if (body.Status !== 0) return [];
    // TXT data comes quoted, possibly as several quoted strings that make one value.
    return (body.Answer ?? [])
      .filter((a) => a.type === 16)
      .map((a) => [...a.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join(""));
  };
}
