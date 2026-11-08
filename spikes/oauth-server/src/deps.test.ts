import { describe, expect, it } from "vitest";
import { createClientMetadataFetch, type FetchLike, workerDeps } from "./deps.ts";
import { bearerToken } from "./introspection.ts";

function recordingFetch(response: Response) {
  const calls: { url: string; redirect: RequestInit["redirect"] }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: input.toString(), redirect: init?.redirect });
    return response;
  };
  return { calls, fetchImpl };
}

describe("client metadata fetch transport", () => {
  it("fetches https documents without following redirects", async () => {
    const { calls, fetchImpl } = recordingFetch(Response.json({ client_id: "x" }));
    const fetchMetadata = createClientMetadataFetch(fetchImpl);
    const response = await fetchMetadata(new Request("https://client.example/metadata.json"));
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ url: "https://client.example/metadata.json", redirect: "manual" }]);
  });

  it("refuses plain http URLs before any request is made", async () => {
    const { calls, fetchImpl } = recordingFetch(new Response("{}"));
    const fetchMetadata = createClientMetadataFetch(fetchImpl);
    await expect(fetchMetadata("http://client.example/metadata.json")).rejects.toThrow("https");
    expect(calls).toHaveLength(0);
  });

  it("fails on a redirect instead of trusting another location", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.example/" },
    });
    const fetchMetadata = createClientMetadataFetch(recordingFetch(redirect).fetchImpl);
    await expect(fetchMetadata(new URL("https://client.example/metadata.json"))).rejects.toThrow(
      "redirects",
    );
  });
});

describe("worker dependencies", () => {
  it("refuses to send OTP email because the spike has no provider", async () => {
    await expect(workerDeps().sendOtp("someone@example.test", "123456")).rejects.toThrow(
      "not configured",
    );
  });

  it("fetches client metadata through the guarded transport", async () => {
    await expect(workerDeps().fetchClientMetadata("http://client.example/x.json")).rejects.toThrow(
      "https",
    );
  });
});

describe("bearer token parsing", () => {
  it("extracts the token from a Bearer header", () => {
    expect(bearerToken("Bearer abc.DEF-123_~+/=")).toBe("abc.DEF-123_~+/=");
  });

  it("ignores other schemes, empty values and missing headers", () => {
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken("Bearer ")).toBeUndefined();
    expect(bearerToken("Bearer a b")).toBeUndefined();
    expect(bearerToken(null)).toBeUndefined();
  });
});
