import { SELF } from "cloudflare:test";
import { TERMS_VERSION } from "@portifact/contracts";
import { THEME_SCRIPT, THEME_SCRIPT_HASH } from "@portifact/contracts/theme";
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

  it("applies the stored theme on every site page with the one inline script its policy allows", async () => {
    const pages = ["/", "/terms", "/privacy", "/acceptable-use", "/mcp-compatibility"];
    // The pages prerendered in Spanish carry the same script, byte for byte, so the hash holds.
    for (const path of [...pages, ...pages.map((page) => `/es${page}`)]) {
      const response = await get(`https://portifact.com${path}`);
      const html = await response.text();
      const head = html.slice(0, html.indexOf("</head>"));
      expect(head, path).toContain(`<script>${THEME_SCRIPT}</script>`);
      expect(html.match(/<script>/g), path).toHaveLength(1);
      // The landing's policy comes from apps/web/public/_headers, the others from the Worker.
      const policy = response.headers.get("content-security-policy");
      if (policy !== null) expect(policy, path).toContain(THEME_SCRIPT_HASH);
    }
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
      expect(html, path).not.toContain("Draft pending legal review");
      expect(html, path).toContain(`<time datetime="${TERMS_VERSION}">`);
      // Everything the page loads is on its own origin, as the policy requires.
      for (const [, url] of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
        expect((await get(`https://portifact.com${url}`)).status, url).toBe(200);
      }
    }
  });

  it("serves the MCP compatibility page with the strict page headers", async () => {
    const response = await get("https://portifact.com/mcp-compatibility");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=");
    const html = await response.text();
    expect(html).toContain(">MCP compatibility</h1>");
    expect(html).toContain("https://app.portifact.com/mcp");
    for (const [, url] of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
      expect((await get(`https://portifact.com${url}`)).status, url).toBe(200);
    }
  });

  it("keeps /mcp on the app host for the MCP server, never the compatibility page", async () => {
    const mcp = await get("https://app.portifact.com/mcp", { method: "POST" });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain("resource_metadata=");
    const page = await get("https://app.portifact.com/mcp-compatibility");
    expect(page.status).toBe(404);
  });

  it("links the legal pages from the landing page", async () => {
    const html = await (await get("https://portifact.com/")).text();
    for (const path of ["/terms", "/privacy", "/acceptable-use"]) {
      expect(html).toContain(`href="${path}"`);
    }
  });

  it("links the MCP compatibility page and the dashboard from the landing page", async () => {
    const html = await (await get("https://portifact.com/")).text();
    expect(html).toContain('href="/mcp-compatibility"');
    expect(html).toContain('href="https://app.portifact.com/"');
    expect((await get("https://portifact.com/mcp-compatibility")).status).toBe(200);
  });

  it("serves the landing in Spanish at /es/ with the same headers as the English one", async () => {
    const english = await get("https://portifact.com/");
    const spanish = await get("https://portifact.com/es/");
    expect(spanish.status).toBe(200);
    expect(spanish.headers.get("content-type")).toContain("text/html");
    for (const header of [
      "content-security-policy",
      "x-frame-options",
      "x-content-type-options",
      "referrer-policy",
      "strict-transport-security",
    ]) {
      expect(spanish.headers.get(header), header).toBe(english.headers.get(header));
    }
    const html = await spanish.text();
    expect(html).toMatch(/<html lang="es"[\s>]/);
    expect(html).toContain('<link rel="canonical" href="https://portifact.com/es/">');
    expect(html).toContain('<link rel="alternate" hreflang="en" href="https://portifact.com/">');
    expect(html).toContain('<link rel="alternate" hreflang="es" href="https://portifact.com/es/">');
    expect(html).toContain('href="/es/terms"');
    expect(html).toContain('href="https://app.portifact.com/?lang=es"');
    expect(html).not.toContain("data-i18n");
    for (const [, url] of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
      expect((await get(`https://portifact.com${url}`)).status, url).toBe(200);
    }
    // The English page names its Spanish alternate and never sends anyone there by itself.
    const englishHtml = await english.text();
    expect(englishHtml).toContain(
      '<link rel="alternate" hreflang="es" href="https://portifact.com/es/">',
    );
    expect(english.status).toBe(200);
  });

  it("sends /es to /es/, where the Spanish landing lives", async () => {
    const response = await get("https://portifact.com/es");
    expect([301, 307, 308]).toContain(response.status);
    expect(new URL(response.headers.get("location") ?? "", "https://portifact.com").pathname).toBe(
      "/es/",
    );
  });

  it("serves the Spanish documents with the strict page headers, legal texts kept in English", async () => {
    for (const path of [
      "/es/terms",
      "/es/privacy",
      "/es/acceptable-use",
      "/es/mcp-compatibility",
    ]) {
      const response = await get(`https://portifact.com${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-security-policy"), path).toBe(PAGE_CSP);
      expect(response.headers.get("cache-control"), path).toBe("no-cache");
      expect(response.headers.get("x-frame-options"), path).toBe("DENY");
      const html = await response.text();
      expect(html, path).toMatch(/<html lang="es"[\s>]/);
    }
    const terms = await (await get("https://portifact.com/es/terms")).text();
    expect(terms).toMatch(/<main[^>]* lang="en"/);
    expect(terms).toContain(">Terms of Service</h1>");
    expect(terms).toContain("data-legal-note");
    expect(terms).toContain('<link rel="canonical" href="https://portifact.com/terms">');
    expect(terms).toContain(`<time datetime="${TERMS_VERSION}">`);
  });

  it("keeps the Spanish pages off the app host", async () => {
    expect((await get("https://app.portifact.com/es/terms")).status).toBe(404);
  });

  it("serves the third-party notices as plain text with the strict page headers", async () => {
    const response = await get("https://portifact.com/third-party-notices");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const text = await response.text();
    expect(text).toContain("# Third-party notices");
    expect(text).toContain("| better-auth | MIT | Workers |");
    const landing = await (await get("https://portifact.com/")).text();
    expect(landing).toContain('href="/third-party-notices"');
    expect((await get("https://app.portifact.com/third-party-notices")).status).toBe(404);
  });

  it("serves the favicon", async () => {
    const response = await get("https://portifact.com/favicon.svg");
    expect(response.status).toBe(200);
  });

  it("serves the wordmarks the emails load", async () => {
    for (const path of ["/brand/wordmark.png", "/brand/wordmark-dark.png"]) {
      const response = await get(`https://portifact.com${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
    }
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
