import { SELF } from "cloudflare:test";
import { TERMS_VERSION } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { PAGE_CSP } from "../src/app-host.ts";

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

  it("serves the legal pages with the strict page headers", async () => {
    for (const [path, title] of [
      ["/terms", "Terms of Service"],
      ["/privacy", "Privacy Policy"],
      ["/acceptable-use", "Acceptable Use Policy"],
    ] as const) {
      const response = await get(`https://portifact.com${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toContain("text/html");
      expect(response.headers.get("content-security-policy"), path).toBe(PAGE_CSP);
      expect(response.headers.get("cache-control"), path).toBe("no-cache");
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(response.headers.get("x-frame-options"), path).toBe("DENY");
      expect(response.headers.get("referrer-policy"), path).toBe("strict-origin-when-cross-origin");
      expect(response.headers.get("strict-transport-security"), path).toContain("max-age=");
      const html = await response.text();
      expect(html, path).toContain(`>${title}</h1>`);
      expect(html, path).toContain("Draft pending legal review");
      expect(html, path).toContain(`<time datetime="${TERMS_VERSION}">`);
      // Everything the page loads is on its own origin, as the policy requires.
      for (const [, url] of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
        expect((await get(`https://portifact.com${url}`)).status, url).toBe(200);
      }
    }
  });

  it("links the legal pages from the landing page", async () => {
    const html = await (await get("https://portifact.com/")).text();
    for (const path of ["/terms", "/privacy", "/acceptable-use"]) {
      expect(html).toContain(`href="${path}"`);
    }
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
    for (const path of ["/index.html", "/install", "/install.ps1", "/terms", "/privacy"]) {
      const response = await get(`https://app.portifact.com${path}`);
      expect(response.status, path).toBe(404);
    }
    // The app root sends visitors to sign in instead of showing the landing.
    const root = await get("https://app.portifact.com/");
    expect(root.status).toBe(302);
    expect(await root.text()).not.toMatch(/<html/i);
  });
});
