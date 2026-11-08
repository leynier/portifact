import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function get(url: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(url, { redirect: "manual", ...init });
}

describe("portifact.com", () => {
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
    const response = await get("https://portifact.com/install", { method: "POST" });
    expect(response.headers.get("location")).toBeNull();
  });

  it("sends www to the apex domain with a permanent redirect and keeps the path", async () => {
    const response = await get("https://www.portifact.com/install?x=1");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://portifact.com/install?x=1");
  });

  it("sends www auth paths to the apex too, where they do not exist", async () => {
    const response = await get("https://www.portifact.com/login");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://portifact.com/login");
  });

  it("serves the landing page from static assets", async () => {
    const response = await get("https://portifact.com/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Share what your agent built");
  });

  it("serves the favicon", async () => {
    const response = await get("https://portifact.com/favicon.svg");
    expect(response.status).toBe(200);
  });

  it("returns 404 for unknown paths", async () => {
    const response = await get("https://portifact.com/does-not-exist");
    expect(response.status).toBe(404);
  });

  it("does not serve the auth pages, which belong to the app host", async () => {
    for (const path of ["/login", "/device", "/consent", "/login.html", "/consent/"]) {
      const response = await get(`https://portifact.com${path}`);
      expect(response.status, path).toBe(404);
    }
  });

  it("does not serve the auth API or OAuth metadata", async () => {
    for (const path of [
      "/api/auth/get-session",
      "/.well-known/oauth-authorization-server/api/auth",
      "/.well-known/oauth-protected-resource/mcp",
      "/mcp",
    ]) {
      const response = await get(`https://portifact.com${path}`);
      expect(response.status, path).toBe(404);
    }
  });
});

describe("host routing", () => {
  it("answers 404 for hosts the Worker does not own", async () => {
    const response = await get("https://evil.example/");
    expect(response.status).toBe(404);
  });

  it("does not serve the landing page or installers on the app host", async () => {
    for (const path of ["/", "/index.html", "/install", "/install.ps1"]) {
      const response = await get(`https://app.portifact.com${path}`);
      expect(response.status, path).toBe(404);
    }
  });
});
