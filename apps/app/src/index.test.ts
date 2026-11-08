import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function get(url: string): Promise<Response> {
  return SELF.fetch(url, { redirect: "manual" });
}

describe("portifact.com worker", () => {
  it("redirects /install to the latest release's install.sh without caching", async () => {
    const response = await get("https://portifact.com/install");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://github.com/leynier/portifact/releases/latest/download/install.sh",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("redirects /install.ps1 to the latest release's install.ps1", async () => {
    const response = await get("https://portifact.com/install.ps1");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://github.com/leynier/portifact/releases/latest/download/install.ps1",
    );
  });

  it("only redirects GET requests for installers", async () => {
    const response = await SELF.fetch("https://portifact.com/install", {
      method: "POST",
      redirect: "manual",
    });
    expect(response.headers.get("location")).toBeNull();
  });

  it("sends www to the apex domain with a permanent redirect and keeps the path", async () => {
    const response = await get("https://www.portifact.com/install?x=1");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://portifact.com/install?x=1");
  });

  it("serves the landing page from static assets", async () => {
    const response = await get("https://portifact.com/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Share what your agent built.");
  });

  it("returns 404 for unknown paths", async () => {
    const response = await get("https://portifact.com/does-not-exist");
    expect(response.status).toBe(404);
  });
});
